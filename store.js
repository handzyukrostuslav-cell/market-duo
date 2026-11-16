const MarkerStore = (function () {
  'use strict';

  const STORAGE_KEYS = {
    INIT_FLAG: 'market_duo_initialized_v1',
    PRODUCTS: 'market_duo_products',
    CATEGORIES: 'market_duo_categories',
    ORDERS: 'market_duo_orders',
    ORDER_COUNTER: 'market_duo_order_counter',
    SETTINGS: 'market_duo_settings'
  };

  const BAGS_CATEGORY = 'Пакети';
  const ADULT_CATEGORY = 'Алкоголь та тютюнові вироби';
  const SYSTEM_CATEGORIES = [BAGS_CATEGORY, ADULT_CATEGORY];

  let products = [];
  let settings = {
    firebaseUrl: 'https://market-duo-default-rtdb.europe-west1.firebasedatabase.app',
    cardNumber: '',let categories = [];
  let orders = [];
  let orderCounter = 0;
  let settings = {
    firebaseUrl: '',
    cardNumber: '',
    cardRecipient: 'MARKET DUO',
    loyaltyThreshold: 3,
    loyaltyDiscount: 5,
    adminPassword: '1111',
    autoHideEmptyCategories: false
  };

  // Кеш відправлених у хмару замовлень (id -> JSON.stringify(order))
  const lastOrdersMap = new Map();

  let syncState = {
    status: 'local', // 'connected' | 'error' | 'local'
    lastSync: null,
    message: 'Локальний режим (Firebase не підключено)'
  };

  function emitUpdated() {
    window.dispatchEvent(
      new CustomEvent('markerstore:updated', {
        detail: { ...syncState }
      })
    );
  }

  function setSyncState(status, message) {
    syncState = {
      status,
      lastSync: status === 'connected' ? Date.now() : syncState.lastSync,
      message
    };
    emitUpdated();
  }

  function getSyncState() {
    return { ...syncState };
  }

  // --- Утиліти ---
  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatMoney(value) {
    const num = Number(value) || 0;
    return (Math.round(num * 100) / 100).toFixed(2);
  }

  function formatDateTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    return d.toLocaleString('uk-UA', {
      day: '2-digit',
      month: '2-digit',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit'
    });
  }

  function normalizePhone(phone) {
    const digits = String(phone || '').replace(/\D/g, '');
    if (!digits) return '';
    if (digits.length === 10 && digits.startsWith('0')) {
      return '38' + digits;
    }
    if (digits.length === 9) {
      return '380' + digits;
    }
    return digits;
  }

  function getQuantityStep(unit) {
    const u = String(unit || '').trim().toLowerCase();
    return u === '1 кг' || u === 'кг' ? 0.5 : 1;
  }

  function compressImageFile(file, maxSide = 360, quality = 0.75) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = (ev) => {
        const img = new Image();
        img.onload = () => {
          let { width, height } = img;
          if (width > maxSide || height > maxSide) {
            if (width >= height) {
              height = Math.round((height * maxSide) / width);
              width = maxSide;
            } else {
              width = Math.round((width * maxSide) / height);
              height = maxSide;
            }
          }
          const canvas = document.createElement('canvas');
          canvas.width = width;
          canvas.height = height;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(img, 0, 0, width, height);
          resolve(canvas.toDataURL('image/jpeg', quality));
        };
        img.onerror = reject;
        img.src = ev.target.result;
      };
      reader.onerror = reject;
      reader.readAsDataURL(file);
    });
  }

  // --- Локальне збереження ---
  function saveLocalAll() {
    try {
      localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
      localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(categories));
      localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(orders));
      localStorage.setItem(STORAGE_KEYS.ORDER_COUNTER, String(orderCounter));
      localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    } catch (e) {
      console.error('Помилка збереження у localStorage:', e);
    }
  }

  function loadLocalAll() {
    try {
      const savedSettings = JSON.parse(localStorage.getItem(STORAGE_KEYS.SETTINGS) || 'null');
      if (savedSettings && typeof savedSettings === 'object') {
        settings = { ...settings, ...savedSettings };
      }

      const savedProducts = JSON.parse(localStorage.getItem(STORAGE_KEYS.PRODUCTS) || 'null');
      if (Array.isArray(savedProducts)) products = savedProducts;

      const savedCategories = JSON.parse(localStorage.getItem(STORAGE_KEYS.CATEGORIES) || 'null');
      if (Array.isArray(savedCategories)) categories = savedCategories;

      const savedOrders = JSON.parse(localStorage.getItem(STORAGE_KEYS.ORDERS) || 'null');
      if (Array.isArray(savedOrders)) {
        orders = savedOrders.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
      }

      const savedCounter = parseInt(localStorage.getItem(STORAGE_KEYS.ORDER_COUNTER) || '0', 10);
      if (!isNaN(savedCounter)) orderCounter = savedCounter;
    } catch (e) {
      console.error('Помилка читання localStorage:', e);
    }
  }

  function seedDefaultsIfNeeded() {
    if (localStorage.getItem(STORAGE_KEYS.INIT_FLAG)) {
      ensureSystemCategories();
      return;
    }

    categories = [
      { name: 'Кава та чай', visible: true },
      { name: 'Випічка та солодощі', visible: true },
      { name: 'Напої', visible: true },
      { name: 'Бакалія', visible: true },
      { name: BAGS_CATEGORY, visible: true },
      { name: ADULT_CATEGORY, visible: true }
    ];

    products = [
      {
        id: 'prod_seed_1',
        code: '1001',
        name: 'Кава зернова MARKET DUO Espresso',
        category: 'Кава та чай',
        unit: '1 кг',
        price: 480,
        emoji: '☕',
        capacity: '100% Арабіка',
        image: '',
        inStock: true,
        isBag: false
      },
      {
        id: 'prod_seed_2',
        code: '1002',
        name: 'Круасан вершковий свіжоспечений',
        category: 'Випічка та солодощі',
        unit: '1 шт',
        price: 38,
        emoji: '🥐',
        capacity: '85 г',
        image: '',
        inStock: true,
        isBag: false
      },
      {
        id: 'prod_seed_3',
        code: '1003',
        name: 'Сік апельсиновий прямого віджиму',
        category: 'Напої',
        unit: '900 мл',
        price: 74,
        emoji: '🧃',
        capacity: '',
        image: '',
        inStock: true,
        isBag: false
      },
      {
        id: 'bag_seed_1',
        code: '9001',
        name: 'Пакет майка фірмовий середній',
        category: BAGS_CATEGORY,
        unit: '1 шт',
        price: 4,
        emoji: '🛍️',
        capacity: 'до 7 кг',
        image: '',
        inStock: true,
        isBag: true
      },
      {
        id: 'bag_seed_2',
        code: '9002',
        name: 'Пакет великий посилений MARKET DUO',
        category: BAGS_CATEGORY,
        unit: '1 шт',
        price: 7,
        emoji: '🛍️',
        capacity: 'до 15 кг',
        image: '',
        inStock: true,
        isBag: true
      },
      {
        id: 'prod_seed_adult_1',
        code: '8001',
        name: 'Вино сухе червоне Каберне (18+)',
        category: ADULT_CATEGORY,
        unit: '750 мл',
        price: 215,
        emoji: '🍷',
        capacity: '',
        image: '',
        inStock: true,
        isBag: false
      }
    ];

    localStorage.setItem(STORAGE_KEYS.INIT_FLAG, 'true');
    saveLocalAll();
  }

  function ensureSystemCategories() {
    SYSTEM_CATEGORIES.forEach((sysName) => {
      if (!categories.some((c) => c.name === sysName)) {
        categories.push({ name: sysName, visible: true });
      }
    });
  }

  // --- Хмарна синхронізація Firebase REST API ---
  function getCleanFirebaseUrl() {
    return String(settings.firebaseUrl || '').trim().replace(/\/+$/, '');
  }

  async function syncNodeToCloud(nodeName, payload) {
    const baseUrl = getCleanFirebaseUrl();
    if (!baseUrl) return false;

    try {
      const res = await fetch(`${baseUrl}/markerplus/${nodeName}.json`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const timeStr = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setSyncState('connected', `Синхронізовано (${timeStr})`);
      return true;
    } catch (e) {
      setSyncState('error', 'Помилка зв’язку з Firebase (працює локальний кеш)');
      return false;
    }
  }

  // Збереження замовлень: індивідуальний PUT лише для змінених замовлень
  async function saveOrders() {
    orders.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
    localStorage.setItem(STORAGE_KEYS.ORDERS, JSON.stringify(orders));

    const baseUrl = getCleanFirebaseUrl();
    if (!baseUrl) {
      setSyncState('local', 'Локальний режим (Firebase не підключено)');
      return;
    }

    const changedOrders = [];
    orders.forEach((order) => {
      const serialized = JSON.stringify(order);
      if (lastOrdersMap.get(order.id) !== serialized) {
        changedOrders.push({ order, serialized });
      }
    });

    if (changedOrders.length === 0) return;

    try {
      await Promise.all(
        changedOrders.map(async ({ order, serialized }) => {
          const res = await fetch(
            `${baseUrl}/markerplus/orders/${encodeURIComponent(order.id)}.json`,
            {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: serialized
            }
          );
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          lastOrdersMap.set(order.id, serialized);
        })
      );
      const timeStr = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setSyncState('connected', `Синхронізовано (${timeStr})`);
    } catch (e) {
      setSyncState('error', 'Помилка збереження замовлення у Firebase');
    }
  }

  async function syncFromCloud() {
    const baseUrl = getCleanFirebaseUrl();
    if (!baseUrl) {
      setSyncState('local', 'Локальний режим (Firebase не підключено)');
      return false;
    }

    try {
      const res = await fetch(`${baseUrl}/markerplus.json`, { cache: 'no-store' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();

      if (data && typeof data === 'object') {
        if (Array.isArray(data.products)) {
          products = data.products;
        }
        if (Array.isArray(data.categories)) {
          categories = data.categories;
          ensureSystemCategories();
        }
        if (data.settings && typeof data.settings === 'object') {
          settings = {
            ...settings,
            ...data.settings,
            firebaseUrl: baseUrl
          };
        }
        if (typeof data.order_counter === 'number') {
          orderCounter = Math.max(orderCounter, data.order_counter);
        }

        if (data.orders && typeof data.orders === 'object') {
          const cloudOrders = Object.values(data.orders).filter(Boolean);
          cloudOrders.sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
          orders = cloudOrders;

          lastOrdersMap.clear();
          orders.forEach((o) => {
            lastOrdersMap.set(o.id, JSON.stringify(o));
          });
        } else if (data.orders === null) {
          orders = [];
          lastOrdersMap.clear();
        }

        saveLocalAll();
      }

      const timeStr = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
      setSyncState('connected', `Онлайн (${timeStr})`);
      return true;
    } catch (e) {
      setSyncState('error', 'Немає зв’язку з Firebase (локальні дані)');
      return false;
    }
  }

  async function pushAllToCloud() {
    const baseUrl = getCleanFirebaseUrl();
    if (!baseUrl) return false;

    try {
      await syncNodeToCloud('products', products);
      await syncNodeToCloud('categories', categories);
      await syncNodeToCloud('order_counter', orderCounter);
      await syncNodeToCloud('settings', settings);

      lastOrdersMap.clear();
      await saveOrders();
      return true;
    } catch (e) {
      setSyncState('error', 'Помилка вивантаження у Firebase');
      return false;
    }
  }

  // --- Налаштування ---
  function getSettings() {
    return { ...settings };
  }

  function updateSettings(patch) {
    settings = { ...settings, ...patch };
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(settings));
    syncNodeToCloud('settings', settings);
  }

  // --- Категорії ---
  function getCategories() {
    return categories.map((c) => ({ ...c }));
  }

  function addCategory(name) {
    const clean = String(name || '').trim();
    if (!clean) return;
    if (!categories.some((c) => c.name.toLowerCase() === clean.toLowerCase())) {
      categories.push({ name: clean, visible: true });
      localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(categories));
      syncNodeToCloud('categories', categories);
    }
  }

  function moveCategory(name, direction) {
    const idx = categories.findIndex((c) => c.name === name);
    if (idx === -1) return;
    const targetIdx = direction === 'up' ? idx - 1 : idx + 1;
    if (targetIdx < 0 || targetIdx >= categories.length) return;

    const temp = categories[idx];
    categories[idx] = categories[targetIdx];
    categories[targetIdx] = temp;

    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(categories));
    syncNodeToCloud('categories', categories);
  }

  function toggleCategoryVisibility(name) {
    const cat = categories.find((c) => c.name === name);
    if (!cat) return;
    cat.visible = cat.visible === false ? true : false;
    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(categories));
    syncNodeToCloud('categories', categories);
  }

  function deleteCategory(name) {
    if (SYSTEM_CATEGORIES.includes(name)) {
      return { ok: false, error: 'Системну категорію не можна видалити.' };
    }
    const hasProducts = products.some((p) => p.category === name);
    if (hasProducts) {
      return { ok: false, error: 'Неможливо видалити категорію, у якій є товари.' };
    }
    categories = categories.filter((c) => c.name !== name);
    localStorage.setItem(STORAGE_KEYS.CATEGORIES, JSON.stringify(categories));
    syncNodeToCloud('categories', categories);
    return { ok: true };
  }

  // --- Товари та пакети ---
  function getProducts() {
    return products.map((p) => ({ ...p }));
  }

  function addProduct(prodData) {
    const catName = String(prodData.category || 'Загальне').trim();
    addCategory(catName);

    const newProd = {
      id: 'prod_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      code: String(prodData.code || '').trim(),
      name: String(prodData.name || '').trim(),
      category: catName,
      unit: String(prodData.unit || '1 шт').trim(),
      price: Math.round((Number(prodData.price) || 0) * 100) / 100,
      emoji: String(prodData.emoji || '📦').trim(),
      capacity: String(prodData.capacity || '').trim(),
      image: String(prodData.image || '').trim(),
      inStock: prodData.inStock !== false,
      isBag: Boolean(prodData.isBag || catName === BAGS_CATEGORY)
    };

    products.unshift(newProd);
    localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
    syncNodeToCloud('products', products);
    return newProd;
  }

  function updateProduct(id, patch) {
    const idx = products.findIndex((p) => p.id === id);
    if (idx === -1) return;
    products[idx] = { ...products[idx], ...patch };
    localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
    syncNodeToCloud('products', products);
  }

  function deleteProduct(id) {
    products = products.filter((p) => p.id !== id);
    localStorage.setItem(STORAGE_KEYS.PRODUCTS, JSON.stringify(products));
    syncNodeToCloud('products', products);
  }

  // --- Замовлення, коди, перерахунок сум та лояльність ---
  function getOrders() {
    return orders.map((o) => ({
      ...o,
      items: (o.items || []).map((it) => ({
        ...it,
        replacement: it.replacement ? { ...it.replacement } : undefined
      }))
    }));
  }

  function getMaxExistingCodeNumber() {
    let maxCode = orderCounter || 0;
    orders.forEach((o) => {
      const parsed = parseInt(String(o.code || '0').replace(/\D/g, ''), 10);
      if (!isNaN(parsed) && parsed > maxCode) {
        maxCode = parsed;
      }
    });
    return maxCode;
  }

  function peekNextOrderCode() {
    const nextNum = getMaxExistingCodeNumber() + 1;
    return String(nextNum).padStart(4, '0');
  }

  function generateNextOrderCode() {
    const nextNum = getMaxExistingCodeNumber() + 1;
    orderCounter = nextNum;
    localStorage.setItem(STORAGE_KEYS.ORDER_COUNTER, String(orderCounter));
    syncNodeToCloud('order_counter', orderCounter);
    return String(nextNum).padStart(4, '0');
  }

  function recalculateOrderTotals(order) {
    if (!order || !Array.isArray(order.items)) return;

    let rawSubtotal = 0;
    order.items.forEach((item) => {
      if (item.status === 'missing') return;
      if (item.status === 'replaced' && item.replacement) {
        rawSubtotal += (Number(item.replacement.price) || 0) * (Number(item.replacement.qty) || 0);
      } else {
        rawSubtotal += (Number(item.price) || 0) * (Number(item.qty) || 0);
      }
    });

    const subtotal = Math.round(rawSubtotal * 100) / 100;
    const discountPercent = Number(order.discountPercent) || 0;
    const discountAmount = Math.round(subtotal * (discountPercent / 100) * 100) / 100;
    const total = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);

    order.subtotal = subtotal;
    order.discountAmount = discountAmount;
    order.total = total;
  }

  function getCustomerLoyalty(phone) {
    const norm = normalizePhone(phone);
    const threshold = Math.max(1, Number(settings.loyaltyThreshold) || 3);
    const discountPercent = Math.max(0, Number(settings.loyaltyDiscount) || 5);

    if (!norm) {
      return {
        successfulCount: 0,
        threshold,
        discountPercent,
        isLoyal: false,
        remainingToDiscount: threshold
      };
    }

    const successfulCount = orders.filter(
      (o) => o.phoneNormalized === norm && o.status !== 'Відхилено'
    ).length;

    return {
      successfulCount,
      threshold,
      discountPercent,
      isLoyal: successfulCount >= threshold,
      remainingToDiscount: Math.max(0, threshold - successfulCount)
    };
  }

  function findActiveOrderForPhone(phone) {
    const norm = normalizePhone(phone);
    if (!norm) return null;
    return (
      orders.find(
        (o) =>
          o.phoneNormalized === norm &&
          (o.status === 'Розміщено' || o.status === 'Комплектується')
      ) || null
    );
  }

  function createOrder({ customerName, customerPhone, comment, paymentMethod, ownBag, items }) {
    const code = generateNextOrderCode();
    const phoneNormalized = normalizePhone(customerPhone);
    const loyalty = getCustomerLoyalty(customerPhone);
    const discountPercent = loyalty.isLoyal ? loyalty.discountPercent : 0;

    const newOrder = {
      id: 'ord_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
      code,
      timestamp: Date.now(),
      status: 'Розміщено',
      customerName: String(customerName || '').trim(),
      customerPhone: String(customerPhone || '').trim(),
      phoneNormalized,
      comment: String(comment || '').trim(),
      paymentMethod: paymentMethod === 'card' ? 'card' : 'cash',
      ownBag: Boolean(ownBag),
      discountPercent,
      subtotal: 0,
      discountAmount: 0,
      total: 0,
      items: (items || []).map((it) => ({ ...it, status: 'active', picked: false })),
      addedNote: '',
      clientApproaching: false,
      clientApproachingTime: '',
      clientConfirmedChanges: false
    };

    recalculateOrderTotals(newOrder);
    orders.unshift(newOrder);
    saveOrders();
    return newOrder;
  }

  function appendItemsToOrder(orderId, newItems) {
    const order = orders.find((o) => o.id === orderId);
    if (!order) return null;

    const addedDescriptions = [];

    (newItems || []).forEach((incoming) => {
      addedDescriptions.push(`${incoming.name} (${incoming.qty} ${incoming.unit})`);
      const existingActive = order.items.find(
        (it) => it.productId === incoming.productId && it.status === 'active'
      );
      if (existingActive) {
        existingActive.qty = Math.round((existingActive.qty + incoming.qty) * 1000) / 1000;
        existingActive.picked = false;
      } else {
        order.items.push({ ...incoming, status: 'active', picked: false });
      }
    });

    const timeStr = new Date().toLocaleTimeString('uk-UA', { hour: '2-digit', minute: '2-digit' });
    const noteChunk = `[${timeStr}] + ${addedDescriptions.join(', ')}`;
    order.addedNote = order.addedNote ? `${order.addedNote}; ${noteChunk}` : noteChunk;

    recalculateOrderTotals(order);
    saveOrders();
    return order;
  }

  function updateOrder(orderId, updaterFn) {
    const order = orders.find((o) => o.id === orderId);
    if (!order) return null;
    updaterFn(order);
    saveOrders();
    return order;
  }

  function init() {
    loadLocalAll();
    seedDefaultsIfNeeded();
    orders.forEach((o) => lastOrdersMap.set(o.id, JSON.stringify(o)));
  }

  return {
    BAGS_CATEGORY,
    ADULT_CATEGORY,
    SYSTEM_CATEGORIES,
    init,
    getSyncState,
    syncFromCloud,
    pushAllToCloud,
    escapeHtml,
    formatMoney,
    formatDateTime,
    normalizePhone,
    getQuantityStep,
    compressImageFile,
    getSettings,
    updateSettings,
    getCategories,
    addCategory,
    moveCategory,
    toggleCategoryVisibility,
    deleteCategory,
    getProducts,
    addProduct,
    updateProduct,
    deleteProduct,
    getOrders,
    peekNextOrderCode,
    generateNextOrderCode,
    recalculateOrderTotals,
    getCustomerLoyalty,
    findActiveOrderForPhone,
    createOrder,
    appendItemsToOrder,
    updateOrder
  };
})();
