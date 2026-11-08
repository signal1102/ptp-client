(() => {
  const config = window.PTP_CONFIG || {};
  const storageKey = "ptp-anonymous-device-v1";
  const activeStatuses = new Set(["request_received", "under_review", "awaiting_payment", "awaiting_payment_confirmation", "payment_confirmed", "purchasing", "on_the_way"]);
  const statusLabels = {
    request_received: "Request received", under_review: "Under review", awaiting_payment: "Awaiting payment",
    awaiting_payment_confirmation: "Awaiting payment confirmation", payment_confirmed: "Payment confirmed",
    purchasing: "Purchasing food", on_the_way: "On the way", delivered: "Delivered", cancelled: "Cancelled",
    expired: "Expired", refund_processing: "Refund processing", refunded: "Refunded"
  };
  const statusUpdates = {
    request_received: "We've received your request. We'll get back to you soon.",
    under_review: "We’re checking the food, final prices and whether your requested delivery time is feasible.",
    awaiting_payment: "Your request is approved. Transfer the exact amount below as soon as possible.",
    awaiting_payment_confirmation: "Awaiting payment confirmation. We’ll update your order once the transfer is verified.",
    payment_confirmed: "Your payment is confirmed. Purchasing can begin.", purchasing: "An agent has started purchasing your food.",
    on_the_way: "Your order is on the way to your delivery point.", delivered: "Your order has been delivered. Enjoy your meal!",
    cancelled: "This order has been cancelled.", expired: "The five-minute payment window expired. You can send a new request.",
    refund_processing: "Your refund is being processed manually to the bank account your transfer came from.",
    refunded: "The refund has been marked as sent. Bank processing times may vary."
  };
  const statusProgress = { request_received: 8, under_review: 18, awaiting_payment: 28, awaiting_payment_confirmation: 38, payment_confirmed: 52, purchasing: 68, on_the_way: 86, delivered: 100, cancelled: 100, expired: 100, refund_processing: 100, refunded: 100 };
  const form = document.querySelector("#request-form");
  const itemList = document.querySelector("#item-list");
  const ordersList = document.querySelector("#orders-list");
  const emptyState = document.querySelector("#empty-state");
  const formMessage = document.querySelector("#form-message");
  const cancelModal = document.querySelector("#cancel-modal");
  const policyModal = document.querySelector("#policy-modal");
  const notificationModal = document.querySelector("#notification-modal");
  let identity;
  let supabaseClient;
  let refreshTimer;
  let selectedCancelOrder;

  function randomToken() {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes)).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
  }

  function getIdentity() {
    try {
      const existing = JSON.parse(localStorage.getItem(storageKey) || "null");
      if (existing && /^[0-9a-f-]{36}$/i.test(existing.deviceId) && typeof existing.token === "string" && existing.token.length >= 40) return existing;
    } catch { /* Regenerate malformed local state. */ }
    const fresh = { deviceId: crypto.randomUUID(), token: randomToken() };
    localStorage.setItem(storageKey, JSON.stringify(fresh));
    return fresh;
  }

  function isConfigured() {
    return Boolean(window.supabase && config.supabaseUrl && !config.supabaseUrl.includes("YOUR_") && config.supabaseAnonKey && !config.supabaseAnonKey.includes("YOUR_"));
  }

  function getClient() {
    if (!isConfigured()) throw new Error("Supabase isn’t configured yet. Add the project URL and publishable key in config.js, then deploy the Edge Function and database migration.");
    if (!supabaseClient) supabaseClient = window.supabase.createClient(config.supabaseUrl, config.supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false } });
    return supabaseClient;
  }

  async function api(action, payload = {}) {
    const { data, error } = await getClient().functions.invoke("customer-api", {
      body: { action, device_id: identity.deviceId, ...payload },
      headers: { "x-device-token": identity.token }
    });
    if (error) {
      let detail = error.message || "The service is temporarily unavailable.";
      try { if (error.context) { const body = await error.context.json(); detail = body.error || detail; } } catch { /* Keep the SDK error. */ }
      throw new Error(detail);
    }
    if (data?.error) throw new Error(data.error);
    return data || {};
  }

  function escapeHtml(value = "") {
    return String(value).replace(/[&<>"']/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  }

  function formatMoney(value) {
    if (value === null || value === undefined || value === "") return "Not quoted yet";
    return new Intl.NumberFormat("en-NG", { style: "currency", currency: "NGN", maximumFractionDigits: 2 }).format(Number(value));
  }

  function formatDate(value, options = {}) {
    if (!value) return "Not available";
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return escapeHtml(value);
    return new Intl.DateTimeFormat("en-NG", { timeZone: config.timezone || "Africa/Lagos", dateStyle: "medium", timeStyle: "short", ...options }).format(date);
  }

  function showMessage(element, text, success = false) {
    element.textContent = text;
    element.hidden = !text;
    element.classList.toggle("is-success", success);
  }

  function addFoodItem(name = "", quantity = 1) {
    const fragment = document.querySelector("#item-template").content.cloneNode(true);
    const row = fragment.querySelector(".item-row");
    row.querySelector('[name="item_name"]').value = name;
    row.querySelector('[name="quantity"]').value = quantity;
    row.querySelector(".remove-item").addEventListener("click", () => {
      if (itemList.children.length <= 1) {
        row.querySelector('[name="item_name"]').value = "";
        row.querySelector('[name="quantity"]').value = "1";
        return;
      }
      row.remove();
      updateItemNumbers();
    });
    itemList.append(fragment);
    updateItemNumbers();
  }

  function updateItemNumbers() {
    [...itemList.querySelectorAll(".item-row")].forEach((row, index) => {
      row.querySelector(".item-index").textContent = String(index + 1).padStart(2, "0");
      row.querySelector(".remove-item").disabled = itemList.children.length === 1;
    });
  }

  function localLagosInputDate(date) {
    return new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos", year: "numeric", month: "2-digit", day: "2-digit" }).format(date);
  }

  function updateScheduleBounds() {
    const now = new Date();
    const max = new Date(now.getTime() + 24 * 60 * 60 * 1000);
    const dateInput = document.querySelector("#delivery-date");
    const timeInput = document.querySelector("#delivery-time");
    dateInput.min = localLagosInputDate(now);
    dateInput.max = localLagosInputDate(max);
    if (dateInput.value === dateInput.min) {
      const lagos = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(now);
      timeInput.min = lagos;
    } else timeInput.min = "00:00";
    if (dateInput.value === dateInput.max) {
      const lagos = new Intl.DateTimeFormat("en-GB", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(max);
      timeInput.max = lagos;
    } else timeInput.max = "23:59";
  }

  function chosenDeliveryInstant() {
    const date = form.elements.delivery_date.value;
    const time = form.elements.delivery_time.value;
    if (!date || !time) return null;
    return new Date(`${date}T${time}:00+01:00`);
  }

  function validateSchedule() {
    updateScheduleBounds();
    const instant = chosenDeliveryInstant();
    if (!instant) return "Choose an exact delivery date and time.";
    const now = Date.now();
    if (instant.getTime() <= now) return "Choose a delivery time in the future (Africa/Lagos time).";
    if (instant.getTime() > now + 24 * 60 * 60 * 1000) return "Choose a delivery time within 24 hours of submitting your request.";
    return "";
  }

  function clearValidation() {
    form.querySelectorAll(".field-error").forEach((element) => { element.textContent = ""; });
    form.querySelectorAll("[aria-invalid='true']").forEach((element) => element.removeAttribute("aria-invalid"));
  }

  function validateForm() {
    clearValidation();
    let firstInvalid;
    const setError = (key, message, input) => {
      const target = form.querySelector(`[data-error="${key}"]`);
      if (target) target.textContent = message;
      if (input) input.setAttribute("aria-invalid", "true");
      firstInvalid ||= input;
    };
    for (const name of ["shop_name", "shop_location", "hostel", "delivery_point"]) {
      const input = form.elements[name];
      if (!input.value.trim()) setError(name, "This field is required.", input);
    }
    const rows = [...itemList.querySelectorAll(".item-row")];
    rows.forEach((row) => {
      const name = row.querySelector('[name="item_name"]');
      const quantity = row.querySelector('[name="quantity"]');
      if (!name.value.trim()) { name.setAttribute("aria-invalid", "true"); firstInvalid ||= name; }
      if (!quantity.validity.valid) { quantity.setAttribute("aria-invalid", "true"); firstInvalid ||= quantity; }
    });
    if (rows.some((row) => !row.querySelector('[name="item_name"]').value.trim())) {
      const firstEmpty = rows.find((row) => !row.querySelector('[name="item_name"]').value.trim())?.querySelector('[name="item_name"]');
      firstEmpty?.focus();
      showMessage(formMessage, "Add a name for every food item and choose a quantity from 1 to 50.");
      return false;
    }
    if (rows.some((row) => !row.querySelector('[name="quantity"]').validity.valid)) {
      showMessage(formMessage, "Each quantity must be a whole number between 1 and 50.");
      rows.find((row) => !row.querySelector('[name="quantity"]').validity.valid)?.querySelector('[name="quantity"]').focus();
      return false;
    }
    const scheduleError = validateSchedule();
    if (scheduleError) setError("delivery_time", scheduleError, form.elements.delivery_time);
    const phone = form.elements.whatsapp;
    if (phone.value.trim() && !/^\+?[0-9][0-9\s().-]{6,18}$/.test(phone.value.trim())) setError("whatsapp", "Enter a valid phone number, including country code if possible.", phone);
    if (!form.elements.policy_ack.checked) setError("policy_ack", "Please confirm you understand the request and cancellation policy.", form.elements.policy_ack);
    if (firstInvalid) {
      showMessage(formMessage, firstInvalid === form.elements.delivery_time ? scheduleError : "Please check the highlighted fields.");
      firstInvalid.focus();
      return false;
    }
    showMessage(formMessage, "");
    return true;
  }

  function makeOrderCard(order) {
    const card = document.querySelector("#order-template").content.firstElementChild.cloneNode(true);
    const expanded = card.querySelector(".order-expanded");
    const status = order.status || "request_received";
    const items = Array.isArray(order.items) ? order.items : [];
    card.dataset.orderId = order.id;
    card.querySelector(".order-reference").textContent = `ORDER ${order.reference || String(order.id).slice(0, 8).toUpperCase()}`;
    card.querySelector(".order-shop").textContent = order.shop_name || "Food request";
    const pill = card.querySelector(".status-pill");
    pill.textContent = statusLabels[status] || status.replaceAll("_", " ");
    pill.dataset.status = status;
    const percentage = statusProgress[status] ?? 8;
    expanded.querySelector(".order-progress").style.setProperty("--progress", `${percentage}%`);
    expanded.querySelector(".progress-fill").style.width = `${percentage}%`;
    const refund = order.refund;
    let statusUpdate = order.latest_update || statusUpdates[status] || "Your order status has been updated.";
    const dueEntries = (refund?.entries || []).filter((entry) => entry.status === "due");
    if (dueEntries.length || refund?.status === "due") {
      const itemsBeingRefunded = (refund.items || []).map((item) => `${item.quantity} × ${item.item_name}`).join(", ");
      const amountDue = dueEntries.reduce((total, entry) => total + Number(entry.amount || 0), 0);
      const refundTarget = itemsBeingRefunded || dueEntries.map((entry) => entry.reason).filter(Boolean).join(", ");
      statusUpdate = `Refund due${refundTarget ? ` for ${refundTarget}` : ""}${dueEntries.length ? `: ${formatMoney(amountDue)}` : ""}. ${refund.note || "Refunds are processed manually."}`;
    }
    card.querySelector(".status-update").textContent = statusUpdate;
    const detailList = expanded.querySelector(".detail-list");
    const foodText = items.length ? items.map((item) => `${item.quantity} × ${item.item_name || item.name}${item.unit_price !== null && item.unit_price !== undefined ? ` (${formatMoney(Number(item.unit_price) * Number(item.quantity))} total)` : ""}`).join(", ") : "Item details unavailable";
    const deliveryTime = order.requested_delivery_at ? formatDate(order.requested_delivery_at) : [order.delivery_date, order.delivery_time].filter(Boolean).join(" ") || "Not provided";
    const details = [["Food requested", foodText], ["Shop location", order.shop_location || "Not provided"], ["Delivery to", [order.hostel, order.delivery_point, order.room].filter(Boolean).join(", ")], ["Requested for", deliveryTime], ["Payment status", (order.payment_status || "not_requested").replaceAll("_", " ")]];
    detailList.innerHTML = details.map(([label, value]) => `<div class="detail-item"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join("");
    const history = Array.isArray(order.history) ? order.history : [];
    if (history.length) {
      const historyDetails = expanded.querySelector(".order-history");
      historyDetails.hidden = false;
      historyDetails.querySelector(".history-list").innerHTML = [...history].sort((first, second) => Date.parse(first.created_at) - Date.parse(second.created_at)).map((entry) => `<li><strong>${escapeHtml(statusLabels[entry.status] || entry.status.replaceAll("_", " "))}</strong><span>${escapeHtml(entry.customer_message || "Order updated")}</span><time datetime="${escapeHtml(entry.created_at)}">${escapeHtml(formatDate(entry.created_at))}</time></li>`).join("");
    }

    const prices = order.pricing || {};
    if (prices.food_subtotal !== undefined || prices.delivery_fee !== undefined || prices.total_amount !== undefined) {
      const pricing = expanded.querySelector(".order-pricing");
      pricing.hidden = false;
      const paid = order.payment_status === "confirmed" ? `<div class="price-row"><span>Total paid</span><strong>${formatMoney(order.total_paid ?? prices.total_amount)}</strong></div>` : "";
      pricing.innerHTML = `<div class="price-row"><span>Food subtotal</span><strong>${formatMoney(prices.food_subtotal)}</strong></div><div class="price-row"><span>Delivery fee</span><strong>${formatMoney(prices.delivery_fee)}</strong></div><div class="price-row total"><span>Total payable</span><strong>${formatMoney(prices.total_amount)}</strong></div>${paid}`;
    } else if (items.length) {
      expanded.querySelector(".order-pricing").hidden = false;
      expanded.querySelector(".order-pricing").innerHTML = "<span class=\"price-note\">Item prices and delivery fee are confirmed during review.</span>";
    }

    const payment = order.payment || {};
    if (["awaiting_payment", "awaiting_payment_confirmation"].includes(status) && order.approved_at) {
      const panel = expanded.querySelector(".payment-panel");
      panel.hidden = false;
      const amount = payment.amount ?? prices.total_amount;
      const deadline = order.payment_deadline_at ? formatDate(order.payment_deadline_at) : "5 minutes after approval";
      const bankDetails = `<div class="bank-grid"><div class="bank-entry"><span>Bank</span><strong>${escapeHtml(payment.bank_name || "Pending assignment")}</strong></div><div class="bank-entry"><span>Account name</span><strong>${escapeHtml(payment.account_name || "Pending assignment")}</strong></div><div class="bank-entry"><span>Account number</span><strong>${escapeHtml(payment.account_number || "Pending assignment")}</strong></div><div class="bank-entry"><span>Exact amount</span><strong>${formatMoney(amount)}</strong></div></div>`;
      if (status === "awaiting_payment") {
        panel.dataset.deadline = order.payment_deadline_at ? String(new Date(order.payment_deadline_at).getTime()) : "";
        panel.innerHTML = `<h4>Payment instructions</h4>${bankDetails}<p class="transfer-instructions">${escapeHtml(payment.instructions || "Transfer the exact amount above. Your order will expire if payment is not confirmed within five minutes.")}</p><p class="deadline-warning" data-payment-countdown>Payment window closes: ${escapeHtml(deadline)}</p><p class="muted-copy">After transferring, let us know below. This does not confirm payment; an authorised operator will verify it.</p><button class="button button-outline button-small" type="button" data-report-transfer="${escapeHtml(order.id)}">I’ve made the transfer</button>`;
      } else {
        panel.innerHTML = `<h4>Awaiting payment confirmation</h4>${bankDetails}<p class="payment-wait">Awaiting payment confirmation</p><p>We’ll update your order when we verify the transfer. Payment status: ${escapeHtml(order.payment_status || "pending")}.</p>`;
      }
    }

    const substitute = order.pending_substitute;
    if (substitute && substitute.status === "pending") {
      const panel = expanded.querySelector(".substitute-panel");
      panel.hidden = false;
      const difference = (Number(substitute.proposed_price) - Number(substitute.original_price)) * Number(substitute.quantity || 1);
      const deadline = new Date(substitute.response_deadline_at).getTime();
      panel.dataset.deadline = Number.isFinite(deadline) ? String(deadline) : "";
      panel.dataset.quantity = String(substitute.quantity || 1);
      panel.dataset.substituteId = substitute.id;
      panel.innerHTML = `<h4>Substitute requested</h4><p><strong>${escapeHtml(substitute.original_item_name)}</strong> is unavailable. Proposed alternative: <strong>${escapeHtml(substitute.proposed_item_name)}</strong> at ${formatMoney(substitute.proposed_price)}. Price difference: <strong>${difference > 0 ? "+" : ""}${formatMoney(difference)}</strong>.</p><p class="deadline-warning" data-countdown></p><p>You have five minutes from when this update was made available. If you decline or don’t respond, the unavailable item will be removed and its cost is due to be refunded manually.</p><div class="substitute-actions"><button class="button button-primary button-small" type="button" data-substitute-decision="approve" data-substitute-id="${escapeHtml(substitute.id)}">Accept substitute</button><button class="button button-outline button-small" type="button" data-substitute-decision="decline" data-substitute-id="${escapeHtml(substitute.id)}">Decline</button></div>`;
    }

    if (refund && refund.status && refund.status !== "none") {
      const panel = expanded.querySelector(".refund-panel");
      panel.hidden = false;
      const items = (refund.items || []).map((item) =>
        `${item.quantity} × ${item.item_name}`).join(", ");
      const entries = (refund.entries || []).map((entry) =>
        `<li><strong>${formatMoney(entry.amount)}</strong> — ${escapeHtml(entry.reason || "Refund due")} (${escapeHtml(entry.status || refund.status)})</li>`).join("");
      panel.innerHTML = `<h4>Refund: ${escapeHtml(refund.status.replaceAll("_", " "))}</h4>${items ? `<p><strong>Items being refunded:</strong> ${escapeHtml(items)}</p>` : ""}${entries ? `<ul class="refund-entry-list">${entries}</ul>` : ""}<p>${escapeHtml(refund.note || "Refunds are processed manually to the bank account the original transfer came from. Processing is not instant.")}</p>`;
    }

    const actions = expanded.querySelector(".order-actions");
    if (order.can_cancel) {
      const cancel = document.createElement("button");
      cancel.className = "text-link";
      cancel.type = "button";
      cancel.textContent = "Request cancellation";
      cancel.dataset.cancelOrder = order.id;
      actions.append(cancel);
    }
    if (order.updated_at || order.created_at) {
      expanded.querySelector(".order-updated").textContent = `Last updated ${formatDate(order.updated_at || order.created_at)}`;
    }
    return card;
  }

  async function refreshOrders() {
    const sync = document.querySelector("#sync-state");
    const syncLabel = document.querySelector("#sync-label");
    try {
      if (!isConfigured()) {
        sync.classList.remove("is-live");
        sync.classList.remove("is-error");
        syncLabel.textContent = "Connect your order tracking";
        emptyState.hidden = false;
        emptyState.querySelector("p").textContent = "Orders will appear here after Supabase is configured and connected.";
        return;
      }
      const result = await api("list-orders");
      const orders = Array.isArray(result.orders) ? result.orders : [];
      const expandedOrderIds = new Set([...ordersList.querySelectorAll(".order-card.is-expanded")].map((card) => card.dataset.orderId));
      ordersList.querySelectorAll(".order-card, .order-empty-message").forEach((element) => element.remove());
      emptyState.hidden = orders.length > 0;
      orders.forEach((order) => {
        const card = makeOrderCard(order);
        if (expandedOrderIds.has(String(order.id))) {
          card.querySelector(".order-expanded").hidden = false;
          card.classList.add("is-expanded");
          const toggle = card.querySelector(".order-toggle");
          toggle.setAttribute("aria-expanded", "true");
          toggle.setAttribute("aria-label", "Hide order details");
        }
        ordersList.append(card);
      });
      document.querySelector("#order-count").textContent = String(orders.filter((order) => activeStatuses.has(order.status)).length);
      sync.classList.add("is-live");
      sync.classList.remove("is-error");
      syncLabel.textContent = `Updated ${new Intl.DateTimeFormat("en-NG", { timeZone: "Africa/Lagos", hour: "2-digit", minute: "2-digit" }).format(new Date())}`;
      const count = Number(result.active_count || 0);
      const limit = Number(result.active_limit || config.activeOrderLimit || 3);
      const limitNote = document.querySelector("#limit-note");
      limitNote.hidden = count < limit;
      limitNote.textContent = count >= limit ? `You have ${count} active requests, the current limit for this device. Start another after one of these is delivered, cancelled or expires.` : "";
      document.querySelector("#submit-button").disabled = count >= limit;
      document.querySelector("#submit-button").textContent = count >= limit ? "Active order limit reached" : "Send food request →";
      tickCountdowns();
    } catch (error) {
      sync.classList.remove("is-live");
      sync.classList.add("is-error");
      syncLabel.textContent = isConfigured() ? "Can’t refresh orders" : "Connect your order tracking";
      emptyState.hidden = false;
      if (!isConfigured()) {
        const text = emptyState.querySelector("p");
        text.textContent = "Orders will appear here after Supabase is configured and connected.";
      }
      if (isConfigured()) console.warn("Order refresh failed:", error.message);
    }
  }

  function tickCountdowns() {
    document.querySelectorAll("[data-countdown]").forEach((element) => {
      if (element.hasAttribute("data-payment-countdown")) {
        const paymentDeadline = Number(element.closest(".payment-panel")?.dataset.deadline);
        if (!paymentDeadline) return;
        const paymentRemaining = paymentDeadline - Date.now();
        if (paymentRemaining <= 0) { element.textContent = "Payment window expired. Check your order for the server-confirmed status."; return; }
        const paymentMinutes = Math.floor(paymentRemaining / 60000);
        const paymentSeconds = Math.floor((paymentRemaining % 60000) / 1000);
        element.textContent = `Payment window closes in ${paymentMinutes}:${String(paymentSeconds).padStart(2, "0")}.`;
        return;
      }
      const deadline = Number(element.closest(".substitute-panel")?.dataset.deadline);
      if (!deadline) { element.textContent = "Response deadline set by Pass the Plate"; return; }
      const remaining = deadline - Date.now();
      if (remaining <= 0) { element.textContent = "The response window has ended. The item will be removed and a manual refund arranged."; return; }
      const minutes = Math.floor(remaining / 60000);
      const seconds = Math.floor((remaining % 60000) / 1000);
      element.textContent = `Respond within ${minutes}:${String(seconds).padStart(2, "0")}.`;
    });
  }

  async function submitOrder(event) {
    event.preventDefault();
    if (!validateForm()) return;
    const button = document.querySelector("#submit-button");
    const original = "Send food request →";
    button.disabled = true;
    button.textContent = "Sending request...";
    try {
      const items = [...itemList.querySelectorAll(".item-row")].map((row) => ({
        item_name: row.querySelector('[name="item_name"]').value.trim(),
        quantity: Number(row.querySelector('[name="quantity"]').value)
      }));
      const instant = chosenDeliveryInstant();
      const result = await api("create-order", {
        order: {
          shop_name: form.elements.shop_name.value.trim(), shop_location: form.elements.shop_location.value.trim(), items,
          instructions: form.elements.instructions.value.trim() || null, hostel: form.elements.hostel.value,
          delivery_point: form.elements.delivery_point.value.trim(), room: form.elements.room.value.trim() || null,
          whatsapp: form.elements.whatsapp.value.trim() || null, requested_delivery_at: instant.toISOString()
        }
      });
      showMessage(formMessage, result.message || "Request received. We’ll review availability, price and delivery feasibility before asking you to pay.", true);
      form.reset();
      document.querySelector("#delivery-date").value = localLagosInputDate(new Date());
      itemList.replaceChildren();
      addFoodItem();
      toggleRoomField();
      updateScheduleBounds();
      await refreshOrders();
      document.querySelector("#progress").scrollIntoView({ behavior: "smooth", block: "start" });
      notificationModal.showModal();
    } catch (error) {
      showMessage(formMessage, error.message || "We couldn’t send your request. Please try again.");
    } finally {
      button.disabled = false;
      button.textContent = original;
      await refreshOrders();
    }
  }

  async function requestCancellation(orderId) {
    selectedCancelOrder = orderId;
    const message = document.querySelector("#cancel-message");
    showMessage(message, "");
    document.querySelector("#cancel-reason").value = "";
    cancelModal.showModal();
  }

  async function submitCancellation() {
    if (!selectedCancelOrder) return;
    const button = document.querySelector("#confirm-cancel");
    button.disabled = true;
    try {
      const reason = document.querySelector("#cancel-reason").value.trim();
      const result = await api("request-cancellation", { order_id: selectedCancelOrder, reason: reason || null });
      cancelModal.close();
      showMessage(formMessage, result.message || "Your cancellation request was sent. We’ll confirm whether purchasing has started.", true);
      await refreshOrders();
    } catch (error) {
      showMessage(document.querySelector("#cancel-message"), error.message || "We couldn’t send this cancellation request.");
    } finally { button.disabled = false; }
  }

  async function decideSubstitute(substituteId, decision, button) {
    button.disabled = true;
    try {
      await api("respond-substitute", { substitute_id: substituteId, decision });
      await refreshOrders();
    } catch (error) {
      const panel = button.closest(".substitute-panel");
      let message = panel.querySelector(".form-message");
      if (!message) { message = document.createElement("p"); message.className = "form-message"; panel.append(message); }
      showMessage(message, error.message);
      button.disabled = false;
    }
  }

  async function reportTransfer(orderId, button) {
    button.disabled = true;
    const previousLabel = button.textContent;
    button.textContent = "Sending...";
    try {
      const result = await api("report-transfer", { order_id: orderId });
      showMessage(formMessage, result.message || "Awaiting payment confirmation.", true);
      await refreshOrders();
    } catch (error) {
      button.disabled = false;
      button.textContent = previousLabel;
      showMessage(formMessage, error.message || "We couldn’t send this update.");
    }
  }

  function toggleRoomField() {
    const show = document.querySelector("#hostel").value === "Male Hall 3";
    const room = document.querySelector("#room");
    room.disabled = !show;
    room.required = false;
    room.closest(".field").hidden = !show;
    document.querySelector("#room-hint").textContent = show ? "Add your room or nearest clear meeting point." : "Add a clear meeting point.";
    if (!show) room.value = "";
  }

  function pushAvailable() {
    return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window && window.isSecureContext;
  }

  function decodeVapidKey(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const raw = atob((value + padding).replaceAll("-", "+").replaceAll("_", "/"));
    return Uint8Array.from(raw, (character) => character.charCodeAt(0));
  }

  async function enablePush() {
    const message = document.querySelector("#notification-message");
    const button = document.querySelector("#enable-notifications");
    if (!pushAvailable()) { showMessage(message, "Push notifications aren’t supported in this browser or connection. Order updates remain available in your progress corner."); return; }
    if (!config.pushVapidPublicKey || config.pushVapidPublicKey.includes("YOUR_")) { showMessage(message, "Push notifications need the public VAPID key in config.js and matching private keys on the server. You can still track updates in your progress corner."); return; }
    button.disabled = true;
    try {
      const permission = await Notification.requestPermission();
      if (permission !== "granted") { showMessage(message, "Notifications weren’t enabled. You can still see all updates in your progress corner."); return; }
      await navigator.serviceWorker.register("./sw.js");
      const registration = await navigator.serviceWorker.ready;

      const subscription = await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidKey(config.pushVapidPublicKey)
      });
      await api("save-push-subscription", { subscription: subscription.toJSON() });
      showMessage(message, "Notifications are on for important order updates.", true);
      window.setTimeout(() => notificationModal.close(), 1100);
    } catch (error) {
      showMessage(message, error.message || "We couldn’t enable notifications. Updates will remain in your progress corner.");
    } finally { button.disabled = false; }
  }

  function configureSupportLink() {
    const link = document.querySelector("#support-link");
    const handle = (config.supportSnapchatHandle || "").trim().replace(/^@/, "");
    if (handle) link.href = `https://www.snapchat.com/add/${encodeURIComponent(handle)}`;
    else { link.href = "#"; link.setAttribute("aria-disabled", "true"); link.textContent = "Snapchat support (handle to be configured)"; link.addEventListener("click", (event) => event.preventDefault()); }
  }

  document.querySelector("#add-item").addEventListener("click", () => addFoodItem());
  document.querySelector("#hostel").addEventListener("change", toggleRoomField);
  document.querySelector("#delivery-date").addEventListener("change", updateScheduleBounds);
  form.addEventListener("submit", submitOrder);
  document.querySelector("#confirm-cancel").addEventListener("click", submitCancellation);
  document.querySelector("#enable-notifications").addEventListener("click", enablePush);
  document.querySelector("#notification-later").addEventListener("click", () => notificationModal.close());
  document.querySelectorAll("[data-open-policy]").forEach((button) => button.addEventListener("click", () => policyModal.showModal()));
  document.querySelectorAll("[data-close-modal]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
  ordersList.addEventListener("click", (event) => {
    const toggle = event.target.closest(".order-toggle");
    const cancel = event.target.closest("[data-cancel-order]");
    const substitute = event.target.closest("[data-substitute-decision]");
    const transfer = event.target.closest("[data-report-transfer]");
    if (toggle) {
      const card = toggle.closest(".order-card");
      const expanded = card.querySelector(".order-expanded");
      expanded.hidden = !expanded.hidden;
      card.classList.toggle("is-expanded", !expanded.hidden);
      toggle.setAttribute("aria-expanded", String(!expanded.hidden));
      toggle.setAttribute("aria-label", expanded.hidden ? "Show order details" : "Hide order details");
    }
    if (cancel) requestCancellation(cancel.dataset.cancelOrder);
    if (substitute) decideSubstitute(substitute.dataset.substituteId, substitute.dataset.substituteDecision, substitute);
    if (transfer) reportTransfer(transfer.dataset.reportTransfer, transfer);
  });
  document.querySelector("#menu-toggle").addEventListener("click", (event) => {
    const button = event.currentTarget;
    const nav = document.querySelector(".header-nav");
    const expanded = button.getAttribute("aria-expanded") === "true";
    button.setAttribute("aria-expanded", String(!expanded));
    button.setAttribute("aria-label", expanded ? "Open navigation" : "Close navigation");
    nav.classList.toggle("is-open", !expanded);
  });
  document.querySelectorAll(".header-nav a").forEach((link) => link.addEventListener("click", () => {
    document.querySelector(".header-nav").classList.remove("is-open");
    document.querySelector("#menu-toggle").setAttribute("aria-expanded", "false");
  }));
  window.addEventListener("online", refreshOrders);
  window.addEventListener("focus", refreshOrders);

  identity = getIdentity();
  addFoodItem();
  toggleRoomField();
  updateScheduleBounds();
  configureSupportLink();
  document.querySelector("#year").textContent = String(new Date().getFullYear());
  document.querySelector("#delivery-date").value = localLagosInputDate(new Date());
  updateScheduleBounds();
  refreshOrders();
  refreshTimer = window.setInterval(refreshOrders, Math.max(10000, Number(config.pollingIntervalMs) || 20000));
  window.addEventListener("pagehide", () => window.clearInterval(refreshTimer), { once: true });
  window.setInterval(tickCountdowns, 1000);
})();
