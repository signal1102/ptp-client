const APP_CONFIG = {
  supportHandle: '@passplate',
  maxOrdersPerDevice: 3,
  maxDeliveryWindowHours: 24,
  timezone: 'Africa/Lagos',
  notificationPermissionMessage:
    'Enable notifications to get updates the moment your order is reviewed, approved, or delivered.',
  supabase: {
    enabled: false,
    url: 'https://your-project.supabase.co',
    anonKey: 'your-anon-key',
  },
  deliveryRateCard: {
    distanceBands: [
      { label: '0-1 km', price: 400 },
      { label: '1-3 km', price: 700 },
      { label: '3-5 km', price: 1200 },
    ],
    urgencyRates: {
      'within 10 minutes': 1.8,
      'within 30 minutes': 1.35,
      'within 60 minutes': 1.1,
      'within 2 hours': 1,
    },
  },
  foodPriceCatalog: {
    'rice and stew': 1800,
    'jollof rice': 2000,
    'fried rice': 2200,
    'plantain and beans': 1700,
    'yam porridge': 2000,
    'eba and egusi': 2600,
    'beans and plantain': 1600,
    'burger and fries': 2400,
    'chicken wrap': 2200,
    'suya': 3000,
    'pepper soup': 2500,
    'salad': 1200,
  },
};

const STORAGE_KEYS = {
  deviceId: 'ptp_device_id',
  orders: 'ptp_orders',
  notificationSubscriptions: 'ptp_notification_subscriptions',
};

const ORDER_STATUSES = [
  'Request received',
  'Under review',
  'Awaiting payment',
  'Awaiting payment confirmation',
  'Payment confirmed',
  'Purchasing food',
  'On the way',
  'Delivered',
  'Cancelled',
  'Expired',
  'Refund processing',
  'Refunded',
];

const ORDER_STATUS_META = {
  'Request received': { cssClass: 'request-received' },
  'Under review': { cssClass: 'under-review' },
  'Awaiting payment': { cssClass: 'awaiting-payment' },
  'Awaiting payment confirmation': { cssClass: 'awaiting-payment-confirmation' },
  'Payment confirmed': { cssClass: 'payment-confirmed' },
  'Purchasing food': { cssClass: 'purchasing-food' },
  'On the way': { cssClass: 'on-the-way' },
  'Delivered': { cssClass: 'delivered' },
  'Cancelled': { cssClass: 'cancelled' },
  'Expired': { cssClass: 'expired' },
  'Refund processing': { cssClass: 'refund-processing' },
  'Refunded': { cssClass: 'refunded' },
};

const state = {
  deviceId: null,
  orders: [],
  activeOrderId: null,
};

const itemRowsContainer = document.getElementById('itemRows');
const orderForm = document.getElementById('orderForm');
const formErrors = document.getElementById('formErrors');
const progressCorner = document.getElementById('progressCorner');
const orderDetailContent = document.getElementById('orderDetailContent');
const orderDetailPanel = document.getElementById('order-detail');
const roomFieldWrap = document.getElementById('roomFieldWrap');
const supportLink = document.getElementById('supportLink');
const enableNotificationsBtn = document.getElementById('enableNotificationsBtn');
const advanceDemoStatusBtn = document.getElementById('advanceDemoStatusBtn');

function safeUuid() {
  if (window.crypto && crypto.randomUUID) {
    return crypto.randomUUID();
  }

  return `ptp-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function getOrCreateDeviceId() {
  const existing = localStorage.getItem(STORAGE_KEYS.deviceId);
  if (existing) {
    return existing;
  }

  const nextId = safeUuid();
  localStorage.setItem(STORAGE_KEYS.deviceId, nextId);
  return nextId;
}

function getOrders() {
  try {
    const raw = localStorage.getItem(STORAGE_KEYS.orders);
    return raw ? JSON.parse(raw) : [];
  } catch (error) {
    return [];
  }
}

function saveOrders() {
  localStorage.setItem(STORAGE_KEYS.orders, JSON.stringify(state.orders));
}

function formatMoney(value) {
  return new Intl.NumberFormat('en-NG', {
    style: 'currency',
    currency: 'NGN',
    maximumFractionDigits: 0,
  }).format(value || 0);
}

function formatDateTime(dateValue) {
  if (!dateValue) return '—';
  const date = new Date(dateValue);
  return new Intl.DateTimeFormat('en-NG', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
}

function getOrderReference(order) {
  return order.orderReference || `PTP-${order.id.slice(0, 8).toUpperCase()}`;
}

function calculateFoodSubtotal(items) {
  return items.reduce((sum, item) => {
    const unitPrice = Number(item.unitPrice) || APP_CONFIG.foodPriceCatalog[item.name?.toLowerCase()] || 1800;
    return sum + unitPrice * Number(item.quantity || 1);
  }, 0);
}

function getDistanceBand(deliveryDestination) {
  const destinationText = String(deliveryDestination || '').toLowerCase();
  if (destinationText.includes('female hall 1') || destinationText.includes('male hall 1')) {
    return '0-1 km';
  }
  if (destinationText.includes('male hall 3') || destinationText.includes('female hall 3')) {
    return '1-3 km';
  }
  return '3-5 km';
}

function calculateDeliveryFee(order) {
  const distanceBand = APP_CONFIG.deliveryRateCard.distanceBands.find((band) => band.label === getDistanceBand(order.deliveryDestination)) || APP_CONFIG.deliveryRateCard.distanceBands[0];
  const urgencyKey = getUrgencyLabel(order.requestedDate, order.requestedTime);
  const urgencyMultiplier = APP_CONFIG.deliveryRateCard.urgencyRates[urgencyKey] || 1;

  return Math.round(Number(distanceBand.price) * urgencyMultiplier);
}

function getUrgencyLabel(requestedDate, requestedTime) {
  if (!requestedDate || !requestedTime) return 'within 2 hours';

  const orderDateTime = new Date(`${requestedDate}T${requestedTime}:00`);
  const now = new Date();
  const differenceMs = orderDateTime.getTime() - now.getTime();
  const minutes = differenceMs / 60000;

  if (minutes <= 10) return 'within 10 minutes';
  if (minutes <= 30) return 'within 30 minutes';
  if (minutes <= 60) return 'within 60 minutes';
  return 'within 2 hours';
}

function buildEmptyItemRow() {
  const row = document.createElement('div');
  row.className = 'food-item-row';
  row.innerHTML = `
    <label>
      Food item name
      <input type="text" name="itemName" placeholder="Example: Jollof rice" required />
    </label>
    <label>
      Quantity
      <input type="number" name="itemQuantity" min="1" value="1" required />
    </label>
    <label>
      Notes
      <input type="text" name="itemNotes" placeholder="Optional" />
    </label>
    <label>
      Price reference
      <input type="text" name="itemPrice" value="" placeholder="Optional" />
    </label>
    <button type="button" class="remove-item-btn" aria-label="Remove this item">Remove</button>
  `;

  row.querySelector('.remove-item-btn').addEventListener('click', () => {
    row.remove();
  });

  itemRowsContainer.appendChild(row);
}

function renderItemRows() {
  itemRowsContainer.innerHTML = '';
  buildEmptyItemRow();
}

function showFormErrors(messages) {
  formErrors.textContent = Array.isArray(messages) ? messages.join(' ') : messages;
}

function validateOrderForm(formData) {
  const errors = [];
  const requiredFields = [
    'shopName',
    'shopLocation',
    'deliveryDestination',
    'requestedDate',
    'requestedTime',
  ];

  requiredFields.forEach((field) => {
    if (!formData.get(field)?.toString().trim()) {
      errors.push(`Please complete the ${field.replace(/([A-Z])/g, ' $1').toLowerCase()} field.`);
    }
  });

  const items = getItemRowsFromForm();
  if (!items.length) {
    errors.push('Please add at least one food item.');
  }

  items.forEach((item, index) => {
    if (!item.name.trim()) {
      errors.push(`Food item ${index + 1} must include a name.`);
    }
    if (!Number.isFinite(Number(item.quantity)) || Number(item.quantity) <= 0) {
      errors.push(`Food item ${index + 1} must have a valid quantity.`);
    }
  });

  if (formData.get('deliveryDestination') === 'Male Hall 3' && !formData.get('deliveryDetail')?.trim()) {
    errors.push('Please provide the room or delivery point for Male Hall 3.');
  }

  if (formData.get('requestedDate') && formData.get('requestedTime')) {
    const requestedDateTime = new Date(`${formData.get('requestedDate')}T${formData.get('requestedTime')}:00`);
    const now = new Date();
    const diffHours = (requestedDateTime.getTime() - now.getTime()) / 3600000;

    if (requestedDateTime <= now) {
      errors.push('The requested delivery time must be in the future.');
    }

    if (diffHours > APP_CONFIG.maxDeliveryWindowHours) {
      errors.push('Orders can only be scheduled up to 24 hours ahead.');
    }
  }

  return errors;
}

function getItemRowsFromForm() {
  const rows = [...document.querySelectorAll('.food-item-row')];

  return rows
    .map((row) => {
      const name = row.querySelector('[name="itemName"]').value.trim();
      const quantity = Number(row.querySelector('[name="itemQuantity"]').value || 1);
      const notes = row.querySelector('[name="itemNotes"]').value.trim();
      const unitPriceValue = row.querySelector('[name="itemPrice"]').value.trim();

      if (!name && !quantity && !notes && !unitPriceValue) {
        return null;
      }

      const unitPrice = Number(unitPriceValue) || APP_CONFIG.foodPriceCatalog[name.toLowerCase()] || 1800;

      return {
        name,
        quantity,
        notes,
        unitPrice,
      };
    })
    .filter(Boolean);
}

function createOrderFromForm(formData) {
  const items = getItemRowsFromForm();
  const foodSubtotal = calculateFoodSubtotal(items);
  const deliveryDestination = formData.get('deliveryDestination');
  const requestedDate = formData.get('requestedDate');
  const requestedTime = formData.get('requestedTime');

  const baseOrder = {
    id: safeUuid(),
    orderReference: `PTP-${Math.random().toString(36).slice(2, 8).toUpperCase()}`,
    deviceId: state.deviceId,
    status: 'Request received',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    shopName: formData.get('shopName').trim(),
    shopLocation: formData.get('shopLocation').trim(),
    foodInstructions: formData.get('foodInstructions').trim(),
    deliveryDestination,
    deliveryDetail: formData.get('deliveryDetail')?.trim() || '',
    whatsapp: formData.get('whatsapp')?.trim() || '',
    requestedDate,
    requestedTime,
    items,
    foodSubtotal,
    deliveryFee: 0,
    totalAmount: 0,
    paymentStatus: 'Not started',
    refundStatus: 'Not applicable',
    bankAccount: {
      bankName: 'Awaiting assignment',
      accountNumber: 'Awaiting assignment',
      accountHolder: 'Awaiting assignment',
      transferInstructions: 'Pass the Plate staff will assign the bank account after review.',
      amountPayable: 0,
    },
  };

  baseOrder.deliveryFee = calculateDeliveryFee(baseOrder);
  baseOrder.totalAmount = Math.round(baseOrder.foodSubtotal + baseOrder.deliveryFee);
  baseOrder.bankAccount.amountPayable = baseOrder.totalAmount;

  return baseOrder;
}

function renderProgressCorner() {
  const orders = [...state.orders].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));

  if (!orders.length) {
    progressCorner.innerHTML = `
      <div class="status-card inactive">
        <div class="status-card-header">
          <h3>No active orders</h3>
          <span class="status-pill request-received">Inactive</span>
        </div>
        <p>Your order progress will appear here once you submit a request.</p>
      </div>
    `;
    return;
  }

  progressCorner.innerHTML = orders
    .map((order) => {
      const statusMeta = ORDER_STATUS_META[order.status] || { cssClass: 'request-received' };
      return `
        <article class="status-card">
          <div class="status-card-header">
            <div>
              <h3>${getOrderReference(order)}</h3>
              <small>${order.shopName} · ${order.deliveryDestination}</small>
            </div>
            <span class="status-pill ${statusMeta.cssClass}">${order.status}</span>
          </div>

          <table>
            <tbody>
              <tr>
                <td>Food requested</td>
                <td>${order.items.map((item) => `${item.name} x${item.quantity}`).join(', ') || 'No items'}</td>
              </tr>
              <tr>
                <td>Delivery time</td>
                <td>${order.requestedDate} at ${order.requestedTime}</td>
              </tr>
              <tr>
                <td>Food total</td>
                <td>${formatMoney(order.foodSubtotal)}</td>
              </tr>
              <tr>
                <td>Delivery fee</td>
                <td>${formatMoney(order.deliveryFee)}</td>
              </tr>
              <tr>
                <td>Total paid</td>
                <td>${formatMoney(order.totalAmount)}</td>
              </tr>
              <tr>
                <td>Updated</td>
                <td>${formatDateTime(order.updatedAt)}</td>
              </tr>
            </tbody>
          </table>

          <div class="actions-row">
            <button class="secondary-button small-button" type="button" data-open-order="${order.id}">View details</button>
          </div>
        </article>
      `;
    })
    .join('');

  progressCorner.querySelectorAll('[data-open-order]').forEach((button) => {
    button.addEventListener('click', () => openOrderDetails(button.dataset.openOrder));
  });
}

function openOrderDetails(orderId) {
  const order = state.orders.find((entry) => entry.id === orderId);
  if (!order) return;

  state.activeOrderId = orderId;
  orderDetailPanel.classList.remove('hidden');

  const paymentPanel = `
    <div class="detail-grid">
      <div class="detail-box">
        <h3>Order summary</h3>
        <ul>
          <li><strong>Reference:</strong> ${getOrderReference(order)}</li>
          <li><strong>Shop:</strong> ${order.shopName}</li>
          <li><strong>Location:</strong> ${order.shopLocation}</li>
          <li><strong>Destination:</strong> ${order.deliveryDestination}${order.deliveryDetail ? ` · ${order.deliveryDetail}` : ''}</li>
          <li><strong>Requested time:</strong> ${order.requestedDate} at ${order.requestedTime}</li>
          <li><strong>WhatsApp:</strong> ${order.whatsapp || 'Not provided'}</li>
        </ul>
      </div>

      <div class="detail-box">
        <h3>Food request</h3>
        <ul>
          ${order.items.map((item) => `<li>${item.name} x${item.quantity}${item.notes ? ` · ${item.notes}` : ''}</li>`).join('') || '<li>No items added.</li>'}
        </ul>
      </div>
    </div>

    <div class="detail-box">
      <h3>Pricing breakdown</h3>
      <div class="money-row"><span>Food subtotal</span><span>${formatMoney(order.foodSubtotal)}</span></div>
      <div class="money-row"><span>Delivery fee</span><span>${formatMoney(order.deliveryFee)}</span></div>
      <div class="money-row total"><span>Total amount payable</span><span>${formatMoney(order.totalAmount)}</span></div>
    </div>

    <div class="detail-box">
      <h3>Bank transfer details</h3>
      <ul>
        <li><strong>Bank:</strong> ${order.bankAccount.bankName}</li>
        <li><strong>Account number:</strong> ${order.bankAccount.accountNumber}</li>
        <li><strong>Account holder:</strong> ${order.bankAccount.accountHolder}</li>
        <li><strong>Transfer instructions:</strong> ${order.bankAccount.transferInstructions}</li>
        <li><strong>Amount payable:</strong> ${formatMoney(order.bankAccount.amountPayable)}</li>
      </ul>
    </div>

    <div class="detail-box">
      <h3>Progress</h3>
      <ul>
        <li><strong>Status:</strong> ${order.status}</li>
        <li><strong>Payment status:</strong> ${order.paymentStatus}</li>
        <li><strong>Refund status:</strong> ${order.refundStatus}</li>
        <li><strong>Updated:</strong> ${formatDateTime(order.updatedAt)}</li>
      </ul>
    </div>
  `;

  orderDetailContent.innerHTML = paymentPanel;
}

function handleSubmitOrder(event) {
  event.preventDefault();

  const existingOrderCount = state.orders.filter((order) => order.deviceId === state.deviceId).length;
  if (existingOrderCount >= APP_CONFIG.maxOrdersPerDevice) {
    showFormErrors(`This device has reached the order limit of ${APP_CONFIG.maxOrdersPerDevice}. Please complete or cancel an existing order before creating a new one.`);
    return;
  }

  const formData = new FormData(orderForm);
  const validationErrors = validateOrderForm(formData);

  if (validationErrors.length) {
    showFormErrors(validationErrors.join(' '));
    return;
  }

  const newOrder = createOrderFromForm(formData);
  state.orders.push(newOrder);
  saveOrders();
  renderProgressCorner();
  openOrderDetails(newOrder.id);
  orderForm.reset();
  renderItemRows();
  showFormErrors('');

  const message = `Your request has been submitted. Your order is saved and is now under review.`;
  alert(message);
}

function resetForm() {
  orderForm.reset();
  renderItemRows();
  showFormErrors('');
}

function bindChangeHandlers() {
  const destinationField = orderForm.elements['deliveryDestination'];
  destinationField.addEventListener('change', () => {
    const isMaleHallThree = destinationField.value === 'Male Hall 3';
    roomFieldWrap.classList.toggle('hidden', !isMaleHallThree);
    if (!isMaleHallThree) {
      orderForm.elements['deliveryDetail'].value = '';
    }
  });

  document.getElementById('addItemBtn').addEventListener('click', buildEmptyItemRow);
  document.getElementById('resetFormBtn').addEventListener('click', resetForm);
  orderForm.addEventListener('submit', handleSubmitOrder);

  document.addEventListener('click', (event) => {
    const target = event.target;
    if (target instanceof HTMLElement && target.matches('[data-open-order]')) {
      openOrderDetails(target.dataset.openOrder);
    }
  });

  advanceDemoStatusBtn.addEventListener('click', () => {
    if (!state.orders.length) {
      alert('Create an order first to test the status flow.');
      return;
    }

    const mostRecent = [...state.orders].sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt))[0];
    advanceOrderStatus(mostRecent.id);
  });
}

function advanceOrderStatus(orderId) {
  const order = state.orders.find((entry) => entry.id === orderId);
  if (!order) return;

  const currentIndex = ORDER_STATUSES.indexOf(order.status);
  const nextStatus = ORDER_STATUSES[currentIndex + 1] || ORDER_STATUSES[0];

  order.status = nextStatus;
  order.updatedAt = new Date().toISOString();

  if (nextStatus === 'Awaiting payment') {
    order.bankAccount = {
      bankName: 'First Bank',
      accountNumber: '2012345678',
      accountHolder: 'Pass the Plate Ltd',
      transferInstructions: 'Transfer the exact amount below into the selected bank account before the 5-minute deadline expires.',
      amountPayable: order.totalAmount,
    };
    order.paymentStatus = 'Awaiting transfer';
  }

  if (nextStatus === 'Awaiting payment confirmation') {
    order.paymentStatus = 'Awaiting payment confirmation';
  }

  if (nextStatus === 'Payment confirmed') {
    order.paymentStatus = 'Confirmed';
  }

  if (nextStatus === 'Delivered') {
    order.paymentStatus = 'Confirmed';
  }

  saveOrders();
  renderProgressCorner();
  openOrderDetails(orderId);
}

function setupNotifications() {
  const supportText = `${APP_CONFIG.notificationPermissionMessage} If browser notifications are unavailable, WhatsApp remains the fallback update channel.`;
  enableNotificationsBtn.title = supportText;

  enableNotificationsBtn.addEventListener('click', async () => {
    if (!('Notification' in window)) {
      alert('This browser does not support web notifications. WhatsApp will be the fallback update method.');
      return;
    }

    if (Notification.permission === 'granted') {
      alert('Notifications are already enabled on this device.');
      return;
    }

    const permission = await Notification.requestPermission();
    if (permission === 'granted') {
      alert('Notification permission granted. The device is ready to receive order updates.');
      const subscriptions = JSON.parse(localStorage.getItem(STORAGE_KEYS.notificationSubscriptions) || '[]');
      subscriptions.push({
        deviceId: state.deviceId,
        permission,
        enabledAt: new Date().toISOString(),
      });
      localStorage.setItem(STORAGE_KEYS.notificationSubscriptions, JSON.stringify(subscriptions));
    } else {
      alert('Notification permission was not granted. WhatsApp remains the fallback update method for your order updates.');
    }
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) {
    return;
  }

  navigator.serviceWorker.register('./sw.js').catch(() => {
    console.warn('Service worker registration failed. Push notifications remain unavailable in this browser.');
  });
}

function hydrateApp() {
  state.deviceId = getOrCreateDeviceId();
  state.orders = getOrders();
  renderItemRows();
  renderProgressCorner();
  bindChangeHandlers();
  setupNotifications();
  registerServiceWorker();

  const supportUrl = `https://snapchat.com/add/${APP_CONFIG.supportHandle.replace('@', '')}`;
  supportLink.href = supportUrl;
  supportLink.textContent = `Message ${APP_CONFIG.supportHandle} on Snapchat`;
}

hydrateApp();
