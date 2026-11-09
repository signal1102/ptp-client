import { createClient } from "npm:@supabase/supabase-js@2";
import webpush from "npm:web-push@3.6.7";


const allowedOrigins = (Deno.env.get("CUSTOMER_ORIGIN") || "")
  .split(",")
  .map((origin) => origin.trim().replace(/\/+$/, ""))
  .filter(Boolean);
const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
const admin = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const operatorStatuses = new Set([
  "request_received", "under_review", "awaiting_payment", "awaiting_payment_confirmation",
  "payment_confirmed", "purchasing", "on_the_way", "delivered", "cancelled", "expired",
  "refund_processing", "refunded",
]);

class ApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

function reply(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: jsonHeaders });
}
function fail(error: unknown, status = 400) {
  const message = error instanceof Error ? error.message : "Request could not be completed.";
  return reply({ error: message }, status);
}
async function sha256(value: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}
function constantTimeEqual(left: string, right: string) {
  const encoder = new TextEncoder();
  const leftBytes = encoder.encode(left);
  const rightBytes = encoder.encode(right);
  if (leftBytes.length !== rightBytes.length) return false;
  let difference = 0;
  for (let index = 0; index < leftBytes.length; index++) difference |= leftBytes[index] ^ rightBytes[index];
  return difference === 0;
}
async function getDevice(req: Request, body: Record<string, unknown>, register = true) {
  const id = typeof body.device_id === "string" ? body.device_id : "";
  const token = req.headers.get("x-device-token") || "";
  if (!/^[0-9a-f-]{36}$/i.test(id) || token.length < 40 || token.length > 100) throw new Error("This browser’s anonymous device token is missing or invalid.");
  const tokenHash = await sha256(token);
  const { data: existing, error } = await admin.from("anonymous_devices").select("id,token_hash,revoked_at").eq("id", id).maybeSingle();
  if (error) throw error;
  if (existing) {
    if (existing.revoked_at || existing.token_hash !== tokenHash) throw new Error("This anonymous device token is invalid or revoked.");
    await admin.from("anonymous_devices").update({ last_seen_at: new Date().toISOString() }).eq("id", id);
  } else if (register) {
    const { error: insertError } = await admin.from("anonymous_devices").insert({ id, token_hash: tokenHash });
    if (insertError) throw new Error("Could not register this browser. Refresh and try again.");
  } else return { id, tokenHash };
  return { id, tokenHash };
}
async function getOperator(req: Request) {
  const authorization = req.headers.get("authorization") || "";
  if (!authorization.startsWith("Bearer ")) throw new ApiError("Operator authentication required.", 401);
  const client = createClient(supabaseUrl, anonKey, { global: { headers: { Authorization: authorization } }, auth: { persistSession: false } });
  const { data: { user }, error } = await client.auth.getUser();
  if (error || !user) throw new ApiError("Operator authentication required.", 401);
  const { data, error: operatorError } = await admin.from("operator_users").select("user_id").eq("user_id", user.id).maybeSingle();
  if (operatorError) throw operatorError;
  if (!data) throw new ApiError("This account is not authorised to perform operator actions.", 403);
  return user;
}
async function expireDeadlines() {
  const { error } = await admin.rpc("expire_customer_deadlines");
  if (error) throw error;
}
async function notifyDevice(deviceId: string, payload: { title: string; body: string; orderId?: string }) {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") || "mailto:support@example.invalid";
  if (!publicKey || !privateKey) return { attempted: false, delivered: 0 };
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const { data: subscriptions, error } = await admin.from("push_subscriptions").select("id,endpoint,subscription").eq("device_id", deviceId);
  if (error) throw error;
  let delivered = 0;
  await Promise.all((subscriptions || []).map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify({ ...payload, url: "./#progress" }), { TTL: "300" });
      delivered++;
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) await admin.from("push_subscriptions").delete().eq("id", row.id);
      console.error("Push delivery failed", status || "unknown");
    }
  }));
  return { attempted: true, delivered };
}
type OperatorNotification = {
  eventId: string;
  type: string;
  orderId: string;
  reference: string;
  shopName: string;
  title: string;
  body: string;
  itemName?: string;
  proposedItemName?: string;
};
async function notifyOperators(payload: OperatorNotification) {
  const publicKey = Deno.env.get("VAPID_PUBLIC_KEY");
  const privateKey = Deno.env.get("VAPID_PRIVATE_KEY");
  const subject = Deno.env.get("VAPID_SUBJECT") || "mailto:support@example.invalid";
  if (!publicKey || !privateKey) {
    console.warn("Operator push skipped because VAPID keys are not configured.");
    return;
  }
  webpush.setVapidDetails(subject, publicKey, privateKey);
  const { data: subscriptions, error } = await admin.from("operator_push_subscriptions")
    .select("id,endpoint,subscription");
  if (error) throw error;

  const notification = {
    ...payload,
    url: `./?orderId=${encodeURIComponent(payload.orderId)}`,
  };
  await Promise.all((subscriptions || []).map(async (row) => {
    try {
      await webpush.sendNotification(row.subscription, JSON.stringify(notification), { TTL: "300" });
    } catch (error) {
      const status = (error as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        const { error: deleteError } = await admin.from("operator_push_subscriptions").delete().eq("id", row.id);
        if (deleteError) console.error("Could not remove expired operator push subscription:", deleteError.message);
      }
      console.error("Operator push delivery failed", status || "unknown");
    }
  }));
}
async function notifyNewOperatorOrder(deviceId: string, rpcResult: unknown, shopName: string, createdAfter: string) {
  try {
    const result = Array.isArray(rpcResult) ? rpcResult[0] : rpcResult;
    const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const id = typeof record.id === "string" ? record.id :
      typeof record.order_id === "string" ? record.order_id :
      typeof record.orderId === "string" ? record.orderId : "";
    let query = admin.from("orders").select("id,reference,shop_name,created_at")
      .eq("device_id", deviceId).eq("shop_name", shopName).gte("created_at", createdAfter)
      .order("created_at", { ascending: false }).limit(1);
    if (id) query = query.eq("id", id);
    const { data: order, error } = await query.maybeSingle();
    if (error) throw error;
    if (!order) return;
    const reference = order.reference || order.id.slice(0, 8).toUpperCase();
    await notifyOperators({
      eventId: `order:${order.id}:${order.created_at}`,
      type: "new_order",
      orderId: order.id,
      reference,
      shopName: order.shop_name || "Food request",
      title: "New order received",
      body: `Order ${reference} · ${order.shop_name || "Food request"}`,
    });
  } catch (error) {
    console.error("Could not notify operators about a new order:", error);
  }
}
async function notifyOperatorTransfer(orderId: string) {
  try {
    const { data: order, error } = await admin.from("orders")
      .select("id,reference,shop_name,transfer_reported_at").eq("id", orderId).single();
    if (error) throw error;
    const reference = order.reference || order.id.slice(0, 8).toUpperCase();
    await notifyOperators({
      eventId: `transfer:${order.id}:${order.transfer_reported_at}`,
      type: "transfer_reported",
      orderId: order.id,
      reference,
      shopName: order.shop_name || "Food request",
      title: "Transfer reported",
      body: `Order ${reference}: the customer says they have made the transfer.`,
    });
  } catch (error) {
    console.error("Could not notify operators about a reported transfer:", error);
  }
}
async function notifyOperatorSubstitute(substituteId: string, decision: string) {
  try {
    const { data: substitute, error } = await admin.from("substitute_requests")
      .select("id,order_id,original_item_name,proposed_item_name,status,responded_at,orders!inner(reference,shop_name)")
      .eq("id", substituteId).single();
    if (error) throw error;
    const order = Array.isArray(substitute.orders) ? substitute.orders[0] : substitute.orders;
    const reference = order?.reference || substitute.order_id.slice(0, 8).toUpperCase();
    const accepted = decision === "approve" || decision === "approved";
    await notifyOperators({
      eventId: `substitute:${substitute.id}:${substitute.responded_at}`,
      type: accepted ? "substitute_accepted" : "substitute_declined",
      orderId: substitute.order_id,
      reference,
      shopName: order?.shop_name || "Food request",
      title: accepted ? "Substitute accepted" : "Substitute declined",
      body: `Order ${reference}: ${substitute.original_item_name} → ${substitute.proposed_item_name}.`,
      itemName: substitute.original_item_name,
      proposedItemName: substitute.proposed_item_name,
    });
  } catch (error) {
    console.error("Could not notify operators about a substitute response:", error);
  }
}
async function notifyOrder(orderId: string, title: string, body: string) {
  const { data: order, error } = await admin.from("orders").select("device_id").eq("id", orderId).single();
  if (error) throw error;
  return notifyDevice(order.device_id, { title, body, orderId });
}
async function listOrders(deviceId: string) {
  await expireDeadlines();
  const { data: orders, error } = await admin.from("orders").select(`
    id,reference,device_id,shop_name,shop_location,hostel,delivery_point,room,whatsapp,instructions,
    requested_delivery_at,status,payment_status,refund_status,food_subtotal,delivery_fee,total_amount,total_paid,
    payment_deadline_at,approved_at,purchasing_started_at,created_at,updated_at,latest_update,
    order_items(id,item_name,quantity,purchased_quantity,unit_price,item_status,purchased_at),
    order_payment_instructions(bank_name,account_number,account_name,amount,instructions),
    refunds(id,amount,reason,status,created_at,updated_at),
    substitute_requests(id,order_item_id,original_item_name,original_price,proposed_item_name,proposed_price,status,response_deadline_at,created_at),
    order_status_history(id,status,customer_message,created_at)
  `).eq("device_id", deviceId).order("created_at", { ascending: false });
  if (error) throw error;
  const shaped = (orders || []).map((order) => {
    const active = ["request_received", "under_review", "awaiting_payment", "awaiting_payment_confirmation", "payment_confirmed", "purchasing", "on_the_way"].includes(order.status);
    const canCancel = active && order.payment_status !== "reported" && (["request_received", "under_review", "awaiting_payment", "awaiting_payment_confirmation", "payment_confirmed"].includes(order.status) || (order.status === "purchasing" && order.order_items.some((item) => ["requested", "available"].includes(item.item_status) && item.quantity > item.purchased_quantity)));
    const pending = order.substitute_requests.find((sub) => sub.status === "pending");
    const refundRows = order.refunds || [];
    const paymentRow = Array.isArray(order.order_payment_instructions) ? order.order_payment_instructions[0] : order.order_payment_instructions;
    const refundStatus = refundRows.length ? refundRows.every((refund) => refund.status === "refunded") ? "refunded" : refundRows.some((refund) => refund.status === "processing") ? "processing" : "due" : "none";
    return {
      ...order,
      device_id: undefined,
      items: order.order_items,
      order_items: undefined,
      payment: paymentRow || null,
      order_payment_instructions: undefined,
      pricing: { food_subtotal: order.food_subtotal, delivery_fee: order.delivery_fee, total_amount: order.total_amount },
      refund: refundRows.length ? {
        status: refundStatus,
        note: "Refunds are processed manually to the bank account the original transfer came from.",
        items: order.order_items
          .filter((item) => ["unavailable", "cancelled"].includes(item.item_status) && Number(item.quantity) > Number(item.purchased_quantity || 0))
          .map((item) => ({
            item_name: item.item_name,
            quantity: Number(item.quantity) - Number(item.purchased_quantity || 0),
          })),
        entries: refundRows.map((refund) => ({
          amount: refund.amount,
          reason: refund.reason,
          status: refund.status,
        })),
      } : null,
      pending_substitute: pending ? { ...pending, quantity: order.order_items.find((item) => item.id === pending.order_item_id)?.quantity || 1 } : null,
      history: order.order_status_history || [],
      can_cancel: canCancel,
    };
  });
  const activeCount = shaped.filter((order) => ["request_received", "under_review", "awaiting_payment", "awaiting_payment_confirmation", "payment_confirmed", "purchasing", "on_the_way"].includes(order.status)).length;
  const { data: setting } = await admin.from("app_settings").select("setting_value").eq("setting_key", "active_order_limit").maybeSingle();
  const parsedLimit = Number(setting?.setting_value ?? 3);
  return { orders: shaped, active_count: activeCount, active_limit: Number.isInteger(parsedLimit) ? parsedLimit : 3 };
}

const operatorListFields = `
  id,reference,shop_name,shop_location,hostel,delivery_point,requested_delivery_at,
  status,payment_status,refund_status,total_amount,created_at
`;

const operatorOrderFields = `
  id,reference,shop_name,shop_location,instructions,hostel,delivery_point,room,whatsapp,
  requested_delivery_at,status,payment_status,refund_status,food_subtotal,delivery_fee,total_amount,total_paid,
  payment_deadline_at,approved_at,transfer_reported_at,payment_confirmed_at,purchasing_started_at,delivered_at,
  created_at,updated_at,latest_update,
  order_items(id,item_name,quantity,purchased_quantity,unit_price,item_status,purchased_at),
  order_payment_instructions(bank_name,account_number,account_name,amount,instructions,assigned_at),
  refunds(id,amount,reason,status,bank_destination_note,created_at,updated_at,processed_at),
  substitute_requests(id,order_item_id,original_item_name,original_price,proposed_item_name,proposed_price,status,notification_attempted_at,made_available_at,response_deadline_at,responded_at,created_at),
  order_status_history(id,status,customer_message,created_at)
`;

function validDateFilter(value: unknown): value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

async function listOperatorOrders(body: Record<string, unknown>) {
  await expireDeadlines();
  const requestedPage = Number(body.page ?? 1);
  const requestedPageSize = Number(body.page_size ?? 25);
  if (!Number.isInteger(requestedPage) || requestedPage < 1 || requestedPage > 10_000) throw new Error("Choose a valid order page.");
  if (!Number.isInteger(requestedPageSize) || requestedPageSize < 1 || requestedPageSize > 100) throw new Error("Page size must be from 1 to 100.");
  if (body.refund_queue !== undefined && typeof body.refund_queue !== "boolean") throw new Error("Choose a valid refund filter.");
  if (body.from && !validDateFilter(body.from)) throw new Error("Choose a valid start date.");
  if (body.to && !validDateFilter(body.to)) throw new Error("Choose a valid end date.");
  if (body.from && body.to && String(body.from) > String(body.to)) throw new Error("The start date must be on or before the end date.");

  let query = admin.from("orders").select(operatorListFields, { count: "exact" }).order("created_at", { ascending: false });
  if (typeof body.status === "string" && body.status) {
    if (!operatorStatuses.has(body.status)) throw new Error("Unsupported order status filter.");
    query = query.eq("status", body.status);
  }
  if (body.refund_queue === true) query = query.neq("refund_status", "none");
  if (typeof body.search === "string" && body.search.trim()) {
    const search = body.search.trim();
    if (search.length > 80 || /[\u0000-\u001f\u007f]/.test(search)) throw new Error("Search using an order reference or food-spot name.");
    const filterValue = search.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
    query = query.or(`reference.ilike."%${filterValue}%",shop_name.ilike."%${filterValue}%"`);
  }
  if (body.from) {
    query = query.gte("created_at", `${body.from}T00:00:00+01:00`);
  }
  if (body.to) {
    const exclusiveEnd = new Date(`${body.to}T00:00:00+01:00`);
    exclusiveEnd.setTime(exclusiveEnd.getTime() + 24 * 60 * 60 * 1000);
    query = query.lt("created_at", exclusiveEnd.toISOString());
  }

  const first = (requestedPage - 1) * requestedPageSize;
  const { data, error, count } = await query.range(first, first + requestedPageSize - 1);
  if (error) throw error;
  return { orders: data || [], total: count || 0, page: requestedPage, page_size: requestedPageSize };
}

async function getOperatorNotificationEvents(body: Record<string, unknown>) {
  if (typeof body.since !== "string" || body.since.length > 40 || !Number.isFinite(Date.parse(body.since))) {
    throw new Error("Choose a valid notification cursor.");
  }
  const since = new Date(body.since).toISOString();
  const [newOrders, reportedTransfers, substituteResponses] = await Promise.all([
    admin.from("orders").select("id,reference,shop_name,created_at")
      .gt("created_at", since).order("created_at", { ascending: true }).limit(100),
    admin.from("orders").select("id,reference,shop_name,transfer_reported_at")
      .eq("payment_status", "reported").gt("transfer_reported_at", since)
      .order("transfer_reported_at", { ascending: true }).limit(100),
    admin.from("substitute_requests")
      .select("id,order_id,original_item_name,proposed_item_name,status,responded_at,orders!inner(reference,shop_name)")
      .in("status", ["approved", "declined"]).gt("responded_at", since)
      .order("responded_at", { ascending: true }).limit(100),
  ]);
  if (newOrders.error) throw newOrders.error;
  if (reportedTransfers.error) throw reportedTransfers.error;
  if (substituteResponses.error) throw substituteResponses.error;

  const events = [
    ...(newOrders.data || []).map((order) => ({
      id: `order:${order.id}:${order.created_at}`,
      type: "new_order",
      order_id: order.id,
      reference: order.reference,
      shop_name: order.shop_name,
      occurred_at: order.created_at,
    })),
    ...(reportedTransfers.data || []).map((order) => ({
      id: `transfer:${order.id}:${order.transfer_reported_at}`,
      type: "transfer_reported",
      order_id: order.id,
      reference: order.reference,
      shop_name: order.shop_name,
      occurred_at: order.transfer_reported_at,
    })),
    ...(substituteResponses.data || []).map((substitute) => {
      const order = Array.isArray(substitute.orders) ? substitute.orders[0] : substitute.orders;
      return {
        id: `substitute:${substitute.id}:${substitute.responded_at}`,
        type: substitute.status === "approved" ? "substitute_accepted" : "substitute_declined",
        order_id: substitute.order_id,
        reference: order?.reference || null,
        shop_name: order?.shop_name || null,
        item_name: substitute.original_item_name,
        proposed_item_name: substitute.proposed_item_name,
        occurred_at: substitute.responded_at,
      };
    }),
  ];
  events.sort((left, right) => Date.parse(left.occurred_at || "") - Date.parse(right.occurred_at || ""));
  return { events };
}

async function getOperatorOrder(value: unknown) {
  await expireDeadlines();
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Choose a valid order.");
  }
  const { data, error } = await admin.from("orders").select(operatorOrderFields).eq("id", value).maybeSingle();
  if (error) throw error;
  if (!data) throw new ApiError("Order not found.", 404);
  return { order: data };
}

Deno.serve(async (req) => {
  const origin = (req.headers.get("origin") || "").replace(/\/+$/, "");
  const allowedOrigin = allowedOrigins.includes(origin) ? origin : "";

  const corsHeaders = {
    ...(allowedOrigin ? { "Access-Control-Allow-Origin": allowedOrigin } : {}),
    "Access-Control-Allow-Headers":
      "authorization, x-client-info, apikey, content-type, x-device-token, x-cron-secret",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };

  const jsonHeaders = {
    ...corsHeaders,
    "Content-Type": "application/json",
  };

  const reply = (data: unknown, status = 200) =>
    new Response(JSON.stringify(data), { status, headers: jsonHeaders });

  const fail = (error: unknown, status = 400) => {
    const message = error instanceof Error
      ? error.message
      : "Request could not be completed.";

    return reply({ error: message }, status);
  };

  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return fail(new Error("Method not allowed."), 405);
  }
  try {
    const body = await req.json() as Record<string, unknown>;
    const action = typeof body.action === "string" ? body.action : "";

    if (action === "system-deadline-reminders") {
      const expectedSecret = Deno.env.get("DEADLINE_CRON_SECRET") || "";
      if (!expectedSecret || !constantTimeEqual(req.headers.get("x-cron-secret") || "", expectedSecret)) throw new Error("Scheduled job authentication failed.");
      const now = new Date();
      const soon = new Date(now.getTime() + 60_000);
      const { data: due, error } = await admin.from("substitute_requests")
        .select("id,order_id,response_deadline_at,orders!inner(device_id)")
        .eq("status", "pending").is("reminder_notification_sent_at", null)
        .gt("response_deadline_at", now.toISOString()).lte("response_deadline_at", soon.toISOString());
      if (error) throw error;
      let delivered = 0;
      for (const substitute of due || []) {
        const orderRelation = substitute.orders as { device_id: string } | { device_id: string }[];
        const order = Array.isArray(orderRelation) ? orderRelation[0] : orderRelation;
        if (!order?.device_id) continue;
        const result = await notifyDevice(order.device_id, {
          title: "One minute left to choose a substitute",
          body: "Your substitute response window is nearly over. Review the option in your Pass the Plate progress corner.",
          orderId: substitute.order_id,
        });
        if (result.delivered > 0) {
          const { error: updateError } = await admin.from("substitute_requests")
            .update({ reminder_notification_sent_at: new Date().toISOString() })
            .eq("id", substitute.id).eq("status", "pending").is("reminder_notification_sent_at", null);
          if (updateError) throw updateError;
          delivered++;
        }
      }
      return reply({ checked: due?.length || 0, delivered });
    }

    if (action.startsWith("operator-")) {
      const operator = await getOperator(req);
      if (action === "operator-session") return reply({ user: { id: operator.id, email: operator.email } });
      if (action === "operator-save-push-subscription") {
        const subscription = body.subscription as {
          endpoint?: unknown;
          keys?: { p256dh?: unknown; auth?: unknown };
        };
        if (
          !subscription || typeof subscription.endpoint !== "string" || subscription.endpoint.length > 2048 ||
          !subscription.endpoint.startsWith("https://") ||
          typeof subscription.keys?.p256dh !== "string" || typeof subscription.keys?.auth !== "string"
        ) throw new Error("Invalid operator push subscription.");
        const { error } = await admin.from("operator_push_subscriptions").upsert({
          user_id: operator.id,
          endpoint: subscription.endpoint,
          subscription,
        }, { onConflict: "endpoint" });
        if (error) throw error;
        return reply({ ok: true });
      }
      if (action === "operator-remove-push-subscription") {
        if (typeof body.endpoint !== "string" || body.endpoint.length > 2048) {
          throw new Error("Invalid operator push endpoint.");
        }
        const { error } = await admin.from("operator_push_subscriptions")
          .delete().eq("user_id", operator.id).eq("endpoint", body.endpoint);
        if (error) throw error;
        return reply({ ok: true });
      }
      if (action === "operator-list-orders") return reply(await listOperatorOrders(body));
      if (action === "operator-notification-events") return reply(await getOperatorNotificationEvents(body));
      if (action === "operator-get-order") return reply(await getOperatorOrder(body.order_id));
      if (action === "operator-approve-order") {
        const { order_id, item_prices, food_subtotal, delivery_fee, bank_name, account_number, account_name, instructions } = body;
        const { error } = await admin.rpc("operator_approve_order", { p_order_id: order_id, p_item_prices: item_prices, p_food_subtotal: food_subtotal, p_delivery_fee: delivery_fee, p_bank_name: bank_name, p_account_number: account_number, p_account_name: account_name, p_payment_instructions: instructions });
        if (error) throw error;
        await notifyOrder(String(order_id), "Request approved", "Your request is approved. Check your progress corner for the itemised total and transfer details.");
        return reply({ ok: true });
      }
      if (action === "operator-set-status") {
        const { order_id, status, message } = body;
        const allowed = new Set(["under_review", "payment_confirmed", "on_the_way", "delivered", "refund_processing", "refunded"]);
        if (typeof status !== "string" || !allowed.has(status)) throw new Error("Unsupported operator status.");
        const { error } = await admin.rpc("operator_set_order_status", { p_order_id: order_id, p_status: status, p_message: message || null });
        if (error) throw error;
        const copy: Record<string, [string, string]> = {
          under_review: ["Request under review", "We’re checking availability, prices and delivery feasibility."],
          payment_confirmed: ["Payment confirmed", "Your transfer has been verified. Purchasing can begin."],
          on_the_way: ["Your order is on the way", "Your food is on its way to your delivery point."],
          delivered: ["Order delivered", "Your order has been marked delivered."],
          refund_processing: ["Refund update", "Your refund is being processed manually."],
          refunded: ["Refund update", "Your refund has been marked as sent."],
        };
        await notifyOrder(String(order_id), ...copy[status]);
        return reply({ ok: true });
      }
      if (action === "operator-start-purchasing") {
        const { error } = await admin.rpc("operator_start_purchasing", { p_order_id: body.order_id });
        if (error) throw error;
        await notifyOrder(String(body.order_id), "Purchasing has started", "An agent has started purchasing your food.");
        return reply({ ok: true });
      }
      if (action === "operator-mark-item-purchased") {
        const quantity = body.quantity === undefined ? null : Number(body.quantity);
        const { error } = await admin.rpc("operator_mark_item_purchased", { p_item_id: body.item_id, p_quantity: quantity });
        if (error) throw error;
        const { data: item, error: itemError } = await admin.from("order_items").select("order_id,item_name").eq("id", body.item_id).single();
        if (itemError) throw itemError;
        await notifyOrder(item.order_id, "Purchasing update", `${item.item_name} has been purchased. Follow your order in the progress corner.`);
        return reply({ ok: true });
      }
      if (action === "operator-mark-item-unavailable") {
        const { error } = await admin.rpc("operator_mark_item_unavailable", { p_item_id: body.item_id });
        if (error) throw error;
        const { data: item, error: itemError } = await admin.from("order_items").select("order_id").eq("id", body.item_id).single();
        if (itemError) throw itemError;
        await notifyOrder(item.order_id, "An item is unavailable", "An unavailable item was removed. Check your progress corner for the refund update.");
        return reply({ ok: true });
      }
      if (action === "operator-propose-substitute") {
        const orderId = String(body.order_id || "");
        const itemId = String(body.order_item_id || "");
        const proposedName = String(body.proposed_item_name || "").trim();
        const proposedPrice = Number(body.proposed_unit_price);
        if (!proposedName || proposedName.length > 120 || !Number.isFinite(proposedPrice) || proposedPrice < 0) throw new Error("Provide a valid substitute and its unit price.");
        const { data: item, error: itemError } = await admin.from("order_items").select("id,item_name,quantity,purchased_quantity,unit_price,item_status,orders!inner(id,device_id)").eq("id", itemId).eq("order_id", orderId).single();
        if (itemError || !item || item.item_status === "purchased" || item.purchased_quantity > 0 || item.unit_price === null) throw new Error("This item cannot be substituted after any of its quantity has been purchased. Mark the remaining unavailable quantity for manual refund instead.");
        const { data: sub, error } = await admin.from("substitute_requests").insert({ order_id: orderId, order_item_id: itemId, original_item_name: item.item_name, original_price: item.unit_price, proposed_item_name: proposedName, proposed_price: proposedPrice, status: "notification_pending" }).select("id").single();
        if (error) throw error;
        const pushResult = await notifyDevice(item.orders.device_id, { title: "A substitute needs your decision", body: "An item is unavailable. Open Pass the Plate to review the proposed alternative.", orderId });
        if (pushResult.delivered > 0) {
          const { error: availableError } = await admin.rpc("operator_make_substitute_available", { p_substitute_id: sub.id });
          if (availableError) throw availableError;
          return reply({ ok: true, notification_attempted: true, response_window_starts_at: new Date().toISOString() });
        }
        return reply({ ok: true, notification_attempted: false, manual_notification_required: true, substitute_id: sub.id, message: "Send the customer an update through WhatsApp if provided, then call operator-confirm-substitute-notified. The five-minute response window has not started." });
      }
      if (action === "operator-confirm-substitute-notified") {
        const { error } = await admin.rpc("operator_make_substitute_available", { p_substitute_id: body.substitute_id });
        if (error) throw error;
        const { data: substitute, error: substituteError } = await admin.from("substitute_requests").select("order_id").eq("id", body.substitute_id).single();
        if (substituteError) throw substituteError;
        await notifyOrder(substitute.order_id, "A substitute needs your decision", "An item is unavailable. Open Pass the Plate to review the proposed alternative.");
        return reply({ ok: true, response_window_starts_at: new Date().toISOString() });
      }
      if (action === "operator-update-revised-quote") {
        const { error } = await admin.rpc("operator_update_revised_quote", { p_order_id: body.order_id, p_delivery_fee: body.delivery_fee });
        if (error) throw error;
        await notifyOrder(String(body.order_id), "Order total updated", "Your item list changed. Check the revised food subtotal and delivery fee in your progress corner.");
        return reply({ ok: true });
      }
      throw new Error("Unknown operator action.");
    }

    const device = await getDevice(req, body);
    if (action === "list-orders") return reply(await listOrders(device.id));
    if (action === "create-order") {
      const order = body.order as Record<string, unknown>;
      if (!order || order.room && order.hostel !== "Male Hall 3") throw new Error("Room numbers are only available for Male Hall 3.");
      const createdAfter = new Date().toISOString();
      const { data, error } = await admin.rpc("create_customer_order", { p_device_id: device.id, p_token_hash: device.tokenHash, p_order: order });
      if (error) throw error;
      await notifyNewOperatorOrder(device.id, data, String(order.shop_name || ""), createdAfter);
      return reply(data);
    }
    if (action === "request-cancellation") {
      const { data, error } = await admin.rpc("customer_request_cancellation", { p_order_id: body.order_id, p_device_id: device.id, p_reason: body.reason || null });
      if (error) throw error;
      return reply({ message: data });
    }
    if (action === "report-transfer") {
      const { error } = await admin.rpc("customer_report_transfer", { p_order_id: body.order_id, p_device_id: device.id });
      if (error) throw error;
      await notifyOperatorTransfer(String(body.order_id));
      return reply({ message: "Awaiting payment confirmation. An authorised operator will verify the transfer." });
    }
    if (action === "respond-substitute") {
      const { error } = await admin.rpc("customer_respond_substitute", { p_substitute_id: body.substitute_id, p_device_id: device.id, p_decision: body.decision });
      if (error) throw error;
      await notifyOperatorSubstitute(String(body.substitute_id), String(body.decision));
      return reply({ ok: true });
    }
    if (action === "save-push-subscription") {
      const subscription = body.subscription as { endpoint?: string };
      if (!subscription?.endpoint || subscription.endpoint.length > 2048) throw new Error("Invalid push subscription.");
      const { error } = await admin.from("push_subscriptions").upsert({ device_id: device.id, endpoint: subscription.endpoint, subscription }, { onConflict: "endpoint" });
      if (error) throw error;
      return reply({ ok: true });
    }
    throw new Error("Unknown customer action.");
  } catch (error) {
    console.error("customer-api error:", error);

    const message =
      error instanceof Error
        ? error.message
        : typeof error === "object" && error !== null && "message" in error
          ? String(error.message)
          : "Request could not be completed.";

    const status = error instanceof ApiError
      ? error.status
      : message.includes("authentication")
        ? 401
        : 400;

    return fail(error, status);
  }
});
