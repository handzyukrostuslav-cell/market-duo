(function () {
  'use strict';

  const FAVORITES_KEY = 'market_duo_favorites';
  const CART_KEY = 'market_duo_cart';
  const PROFILE_KEY = 'market_duo_profile';
  const AGE_VERIFIED_KEY = 'market_duo_age_verified';

  let currentMainTab = 'catalog'; // 'catalog' | 'favorites' | 'adult' | 'cabinet'
  let selectedCategory = 'all';
  let searchQuery = '';
  let favorites = new Set();
  let cart = []; // [{ productId, qty }]
  let modalBagQuantities = {}; // { bagProductId: qty }
  let cabinetSyncTimer = null;
  let memoryAgeVerified = false;

  const clientMemoryStore = new Map();
  function readClientStorage(key) {
    try {
      return localStorage.getItem(key);
    } catch (e) {
      return clientMemoryStore.has(key) ? clientMemoryStore.get(key) : null;
    }
  }

  function writeClientStorage(key, val) {
    try {
      localStorage.setItem(key, val);
    } catch (e) {
      clientMemoryStore.set(key, String(val));
    }
  }

  // --- Робота з localStorage клієнта ---
  function loadClientState() {
    try {
      const savedFavs = JSON.parse(readClientStorage(FAVORITES_KEY) || '[]');
      if (Array.isArray(savedFavs)) favorites = new Set(savedFavs);
    } catch (e) {
      favorites = new Set();
    }

    try {
      const savedCart = JSON.parse(readClientStorage(CART_KEY) || '[]');
      if (Array.isArray(savedCart)) cart = savedCart;
    } catch (e) {
      cart = [];
    }

    try {
      const profile = JSON.parse(readClientStorage(PROFILE_KEY) || '{}');
      if (profile.name) {
        const nameInput = document.getElementById('customerNameInput');
        if (nameInput) nameInput.value = profile.name;
      }
      if (profile.phone) {
        const phoneInput = document.getElementById('customerPhoneInput');
        const cabPhoneInput = document.getElementById('cabinetPhoneInput');
        if (phoneInput) phoneInput.value = profile.phone;
        if (cabPhoneInput) cabPhoneInput.value = profile.phone;
      }
    } catch (e) {
      // ignore
    }
  }

  function saveFavorites() {
    writeClientStorage(FAVORITES_KEY, JSON.stringify(Array.from(favorites)));
    updateHeaderBadges();
  }

  function saveCart() {
    writeClientStorage(CART_KEY, JSON.stringify(cart));
    updateHeaderBadges();
  }

  function saveProfile(name, phone) {
    writeClientStorage(
      PROFILE_KEY,
      JSON.stringify({
        name: String(name || '').trim(),
        phone: String(phone || '').trim()
      })
    );
  }

  function isAgeVerified() {
    if (memoryAgeVerified) return true;
    try {
      return sessionStorage.getItem(AGE_VERIFIED_KEY) === 'true';
    } catch (e) {
      return memoryAgeVerified;
    }
  }

  function setAgeVerified() {
    memoryAgeVerified = true;
    try {
      sessionStorage.setItem(AGE_VERIFIED_KEY, 'true');
    } catch (e) {
      // ignore
    }
  }

  // --- Оновлення лічильників у шапці ---
  function updateHeaderBadges() {
    const favBadge = document.getElementById('favCountBadge');
    if (favBadge) favBadge.textContent = String(favorites.size);

    const cartBadge = document.getElementById('cartCountBadge');
    if (cartBadge) {
      cartBadge.textContent = String(cart.length);
    }

    // Червоний значок ! на "Мій кабінет", якщо є замовлення зі статусом "Очікує підтвердження клієнта"
    const alertBadge = document.getElementById('cabinetAlertBadge');
    if (alertBadge) {
      const phone = getActiveClientPhone();
      const norm = MarkerStore.normalizePhone(phone);
      let needsApproval = false;
      if (norm) {
        needsApproval = MarkerStore.getOrders().some(
          (o) => o && o.phoneNormalized === norm && o.status === 'Очікує підтвердження клієнта'
        );
      }
      alertBadge.classList.toggle('hidden', !needsApproval);
    }
  }

  function getActiveClientPhone() {
    const cabInput = document.getElementById('cabinetPhoneInput');
    const cartInput = document.getElementById('customerPhoneInput');
    if (cabInput && cabInput.value.trim()) return cabInput.value.trim();
    if (cartInput && cartInput.value.trim()) return cartInput.value.trim();
    try {
      const profile = JSON.parse(readClientStorage(PROFILE_KEY) || '{}');
      return profile.phone || '';
    } catch (e) {
      return '';
    }
  }

  // --- Навігація по вкладках ---
  function switchMainTab(tabName) {
    if (tabName === 'adult' && !isAgeVerified()) {
      document.getElementById('ageModal').classList.remove('hidden');
      return;
    }

    currentMainTab = tabName;

    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    const catalogView = document.getElementById('view-catalog');
    const cabinetView = document.getElementById('view-cabinet');
    const adultBanner = document.getElementById('adultSectionBanner');

    if (tabName === 'cabinet') {
      catalogView.classList.add('hidden');
      cabinetView.classList.remove('hidden');
      renderCabinetView();
    } else {
      cabinetView.classList.add('hidden');
      catalogView.classList.remove('hidden');
      adultBanner.classList.toggle('hidden', tabName !== 'adult');

      if (tabName === 'favorites') {
        selectedCategory = 'favorites';
      } else if (tabName === 'adult') {
        selectedCategory = MarkerStore.ADULT_CATEGORY;
      } else {
        if (selectedCategory === 'favorites' || selectedCategory === MarkerStore.ADULT_CATEGORY) {
          selectedCategory = 'all';
        }
      }

      renderCategoryChips();
      renderProductsGrid();
    }
  }

  // --- Категорії та вітрина товарів ---
  function renderCategoryChips() {
    const container = document.getElementById('categoryChips');
    if (!container) return;

    if (currentMainTab === 'adult') {
      container.innerHTML = `
        <button type="button" class="chip active" data-cat="${MarkerStore.escapeHtml(MarkerStore.ADULT_CATEGORY)}">
          🔞 Алкоголь та тютюнові вироби
        </button>
      `;
      return;
    }

    const categories = MarkerStore.getCategories();
    const products = MarkerStore.getProducts();
    const settings = MarkerStore.getSettings();
    const autoHideEmpty = Boolean(settings.autoHideEmptyCategories);
    const esc = MarkerStore.escapeHtml;

    const chips = [
      `<button type="button" class="chip ${selectedCategory === 'all' ? 'active' : ''}" data-cat="all">Усі товари</button>`,
      `<button type="button" class="chip ${selectedCategory === 'favorites' ? 'active' : ''}" data-cat="favorites">❤️ Обране (${favorites.size})</button>`
    ];

    categories.forEach((cat) => {
      if (!cat || !cat.name) return;
      if (cat.name === MarkerStore.ADULT_CATEGORY) return;
      if (cat.visible === false) return;

      if (autoHideEmpty) {
        const hasProducts = products.some((p) => p && p.category === cat.name);
        if (!hasProducts) return;
      }

      chips.push(`
        <button
          type="button"
          class="chip ${selectedCategory === cat.name ? 'active' : ''}"
          data-cat="${esc(cat.name)}"
        >${esc(cat.name)}</button>
      `);
    });

    container.innerHTML = chips.join('');
  }

  function renderProductsGrid() {
    const grid = document.getElementById('productsGrid');
    const emptyState = document.getElementById('catalogEmptyState');
    const titleEl = document.getElementById('catalogSectionTitle');
    const countEl = document.getElementById('catalogItemsCount');
    if (!grid) return;

    const allProducts = MarkerStore.getProducts().filter((p) => p && typeof p === 'object');
    let filtered = [];

    if (currentMainTab === 'adult') {
      titleEl.textContent = 'Алкоголь та тютюнові вироби (18+)';
      filtered = allProducts.filter((p) => p.category === MarkerStore.ADULT_CATEGORY);
    } else if (selectedCategory === 'favorites') {
      titleEl.textContent = '❤️ Обрані товари';
      filtered = allProducts.filter((p) => {
        if (!favorites.has(p.id)) return false;
        if (p.category === MarkerStore.ADULT_CATEGORY && !isAgeVerified()) return false;
        return true;
      });
    } else if (selectedCategory === 'all') {
      titleEl.textContent = 'Усі товари';
      filtered = allProducts.filter((p) => p.category !== MarkerStore.ADULT_CATEGORY);
    } else {
      titleEl.textContent = selectedCategory;
      filtered = allProducts.filter((p) => p.category === selectedCategory);
    }

    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      filtered = filtered.filter(
        (p) =>
          String(p.name || '').toLowerCase().includes(q) ||
          String(p.category || '').toLowerCase().includes(q)
      );
    }

    // Сортування за наявністю: inStock !== false завжди зверху, inStock === false — в кінці
    filtered.sort((a, b) => {
      const aStock = a.inStock !== false ? 1 : 0;
      const bStock = b.inStock !== false ? 1 : 0;
      return bStock - aStock;
    });

    countEl.textContent = `${filtered.length} тов.`;

    if (filtered.length === 0) {
      grid.innerHTML = '';
      emptyState.classList.remove('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    const esc = MarkerStore.escapeHtml;

    grid.innerHTML = filtered.map((prod) => {
      const inStock = prod.inStock !== false;
      const isFav = favorites.has(prod.id);
      const cartItem = cart.find((c) => c.productId === prod.id);
      const qtyInCart = cartItem ? cartItem.qty : 0;

      return `
        <article class="product-card ${!inStock ? 'out-of-stock' : ''}">
          <button
            type="button"
            class="fav-btn ${isFav ? 'active' : ''}"
            data-action="toggle-fav"
            data-id="${esc(prod.id)}"
            aria-label="Додати в обране"
            title="${isFav ? 'Прибрати з обраного' : 'Додати в обране'}"
          >${isFav ? '❤️' : '🤍'}</button>

          ${!inStock ? '<span class="out-of-stock-badge">Немає в наявності</span>' : ''}

          <div class="product-media">
            ${prod.image
              ? `<img src="${esc(prod.image)}" alt="${esc(prod.name)}" loading="lazy">`
              : `<span class="product-emoji">${esc(prod.emoji || '📦')}</span>`}
          </div>

          <div class="product-body">
            <span class="product-category-label">${esc(prod.category)}</span>
            <h3 class="product-title">${esc(prod.name)}</h3>
            <div class="product-unit">
              ${esc(prod.unit)}
              ${prod.capacity ? ` • ${esc(prod.capacity)}` : ''}
            </div>

            <div class="product-footer">
              <div class="product-price">${MarkerStore.formatMoney(prod.price)} <span>грн</span></div>

              ${!inStock ? `
                <button type="button" class="btn btn-sm btn-disabled" disabled>Немає в наявності</button>
              ` : qtyInCart > 0 ? `
                <div class="qty-stepper">
                  <button type="button" class="qty-btn" data-action="cart-dec" data-id="${esc(prod.id)}">−</button>
                  <span class="qty-val">${qtyInCart}</span>
                  <button type="button" class="qty-btn" data-action="cart-inc" data-id="${esc(prod.id)}">+</button>
                </div>
              ` : `
                <button
                  type="button"
                  class="btn btn-sm btn-primary"
                  data-action="cart-add"
                  data-id="${esc(prod.id)}"
                >+ У кошик</button>
              `}
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  // --- Керування кошиком ---
  function addToCart(productId) {
    const product = MarkerStore.getProducts().find((p) => p.id === productId);
    if (!product || product.inStock === false) return;

    const step = MarkerStore.getQuantityStep(product.unit);
    const existing = cart.find((c) => c.productId === productId);
    if (existing) {
      existing.qty = Math.round((existing.qty + step) * 100) / 100;
    } else {
      cart.push({ productId, qty: step });
    }
    saveCart();
    renderProductsGrid();
    renderCartDrawer();
  }

  function changeCartQty(productId, deltaDirection) {
    const product = MarkerStore.getProducts().find((p) => p.id === productId);
    if (!product) return;

    const step = MarkerStore.getQuantityStep(product.unit);
    const idx = cart.findIndex((c) => c.productId === productId);
    if (idx === -1) return;

    const nextQty = Math.round((cart[idx].qty + deltaDirection * step) * 100) / 100;
    if (nextQty <= 0) {
      cart.splice(idx, 1);
    } else {
      cart[idx].qty = nextQty;
    }

    saveCart();
    renderProductsGrid();
    renderCartDrawer();
  }

  function openCartDrawer() {
    renderCartDrawer();
    document.getElementById('cartBackdrop').classList.remove('hidden');
    document.getElementById('cartDrawer').classList.add('open');
    document.getElementById('cartDrawer').setAttribute('aria-hidden', 'false');
  }

  function closeCartDrawer() {
    document.getElementById('cartBackdrop').classList.add('hidden');
    document.getElementById('cartDrawer').classList.remove('open');
    document.getElementById('cartDrawer').setAttribute('aria-hidden', 'true');
  }

  function calculateCartSummary(customCartList = cart) {
    const products = MarkerStore.getProducts();
    let subtotal = 0;

    customCartList.forEach((entry) => {
      const prod = products.find((p) => p.id === entry.productId);
      if (!prod) return;
      subtotal += (Number(prod.price) || 0) * (Number(entry.qty) || 0);
    });

    subtotal = Math.round(subtotal * 100) / 100;

    const phone = document.getElementById('customerPhoneInput')?.value || '';
    const loyalty = MarkerStore.getCustomerLoyalty(phone);
    const discountPercent = loyalty.isLoyal ? loyalty.discountPercent : 0;
    const discountAmount = Math.round(subtotal * (discountPercent / 100) * 100) / 100;
    const total = Math.max(0, Math.round((subtotal - discountAmount) * 100) / 100);

    return {
      subtotal,
      discountPercent,
      discountAmount,
      total,
      loyalty
    };
  }

  function renderCartDrawer() {
    const emptyState = document.getElementById('emptyCartState');
    const itemsList = document.getElementById('cartItemsList');
    const bagsSection = document.getElementById('cartBagsSection');
    const bagsList = document.getElementById('cartBagsList');
    const checkoutForm = document.getElementById('checkoutForm');

    const products = MarkerStore.getProducts();
    const esc = MarkerStore.escapeHtml;

    cart = cart.filter((entry) => products.some((p) => p.id === entry.productId));

    if (cart.length === 0) {
      emptyState.classList.remove('hidden');
      itemsList.innerHTML = '';
      bagsSection.classList.add('hidden');
      checkoutForm.classList.add('hidden');
      return;
    }

    emptyState.classList.add('hidden');
    checkoutForm.classList.remove('hidden');

    itemsList.innerHTML = cart.map((entry) => {
      const prod = products.find((p) => p.id === entry.productId);
      if (!prod) return '';
      const lineSum = Math.round((Number(prod.price) || 0) * entry.qty * 100) / 100;

      return `
        <div class="cart-item-row">
          <div class="cart-item-info">
            <strong>${esc(prod.name)}</strong>
            <span class="cart-item-meta">${MarkerStore.formatMoney(prod.price)} грн / ${esc(prod.unit)}</span>
          </div>

          <div class="cart-item-controls">
            <div class="qty-stepper qty-stepper-sm">
              <button type="button" class="qty-btn" data-cart-action="dec" data-id="${esc(prod.id)}">−</button>
              <span class="qty-val">${entry.qty}</span>
              <button type="button" class="qty-btn" data-cart-action="inc" data-id="${esc(prod.id)}">+</button>
            </div>
            <strong class="cart-item-sum">${MarkerStore.formatMoney(lineSum)} грн</strong>
          </div>
        </div>
      `;
    }).join('');

    // Окремий блок «🛍️ Пакети до замовлення»
    const availableBags = products.filter(
      (p) => (p.isBag || p.category === MarkerStore.BAGS_CATEGORY) && p.inStock !== false
    );

    if (availableBags.length > 0) {
      bagsSection.classList.remove('hidden');
      bagsList.innerHTML = availableBags.map((bag) => {
        const inCart = cart.find((c) => c.productId === bag.id);
        const qty = inCart ? inCart.qty : 0;

        return `
          <div class="cart-bag-row">
            <div class="cart-bag-info">
              <strong>${esc(bag.name)}</strong>
              <span>${bag.capacity ? esc(bag.capacity) + ' • ' : ''}${MarkerStore.formatMoney(bag.price)} грн / шт</span>
            </div>
            <div>
              ${qty > 0 ? `
                <div class="qty-stepper qty-stepper-sm">
                  <button type="button" class="qty-btn" data-cart-action="dec" data-id="${esc(bag.id)}">−</button>
                  <span class="qty-val">${qty}</span>
                  <button type="button" class="qty-btn" data-cart-action="inc" data-id="${esc(bag.id)}">+</button>
                </div>
              ` : `
                <button
                  type="button"
                  class="btn btn-xs btn-outline"
                  data-cart-action="add"
                  data-id="${esc(bag.id)}"
                >+ Додати</button>
              `}
            </div>
          </div>
        `;
      }).join('');
    } else {
      bagsSection.classList.add('hidden');
    }

    updateCartCheckoutState();
  }

  function updateCartCheckoutState() {
    const phone = document.getElementById('customerPhoneInput').value;
    const summary = calculateCartSummary(cart);

    document.getElementById('cartSubtotal').textContent = `${MarkerStore.formatMoney(summary.subtotal)} грн`;
    const discountRow = document.getElementById('cartDiscountRow');
    if (summary.discountPercent > 0) {
      discountRow.classList.remove('hidden');
      document.getElementById('cartDiscountLabel').textContent = `Знижка постійного клієнта (-${summary.discountPercent}%):`;
      document.getElementById('cartDiscountAmount').textContent = `-${MarkerStore.formatMoney(summary.discountAmount)} грн`;
    } else {
      discountRow.classList.add('hidden');
    }
    document.getElementById('cartGrandTotal').textContent = `${MarkerStore.formatMoney(summary.total)} грн`;

    // Перевірка активного замовлення для дозамовлення без нового коду
    const activeOrder = MarkerStore.findActiveOrderForPhone(phone);
    const activeBanner = document.getElementById('activeOrderBanner');
    if (activeOrder) {
      activeBanner.classList.remove('hidden');
      document.getElementById('activeOrderCodeText').textContent = `#${activeOrder.code}`;
      activeBanner.dataset.activeOrderId = activeOrder.id;
    } else {
      activeBanner.classList.add('hidden');
      delete activeBanner.dataset.activeOrderId;
    }

    // Реквізити оплати на картку
    const settings = MarkerStore.getSettings();
    document.getElementById('displayCardNumber').textContent = settings.cardNumber || 'Не вказано адміністратором';
    document.getElementById('displayCardRecipient').textContent = settings.cardRecipient || 'MARKET DUO';
    document.getElementById('previewOrderCode').textContent = MarkerStore.peekNextOrderCode();
  }

  // --- Модальне вікно вибору пакета перед замовленням ---
  function openBagSelectionModal() {
    const products = MarkerStore.getProducts();
    const availableBags = products.filter(
      (p) => (p.isBag || p.category === MarkerStore.BAGS_CATEGORY) && p.inStock !== false
    );

    if (availableBags.length === 0) {
      finalizeNewOrder(false);
      return;
    }

    modalBagQuantities = {};
    availableBags.forEach((bag) => {
      const inCart = cart.find((c) => c.productId === bag.id);
      modalBagQuantities[bag.id] = inCart ? inCart.qty : 0;
    });

    renderBagModalContent();
    document.getElementById('bagModal').classList.remove('hidden');
  }

  function renderBagModalContent() {
    const listEl = document.getElementById('bagModalList');
    const totalEl = document.getElementById('bagModalTotal');
    const products = MarkerStore.getProducts();
    const availableBags = products.filter(
      (p) => (p.isBag || p.category === MarkerStore.BAGS_CATEGORY) && p.inStock !== false
    );
    const esc = MarkerStore.escapeHtml;

    listEl.innerHTML = availableBags.map((bag) => {
      const qty = modalBagQuantities[bag.id] || 0;
      return `
        <div class="bag-modal-row">
          <div>
            <strong>${esc(bag.name)}</strong>
            <div class="text-muted">${bag.capacity ? esc(bag.capacity) + ' • ' : ''}${MarkerStore.formatMoney(bag.price)} грн / шт</div>
          </div>
          <div class="qty-stepper">
            <button type="button" class="qty-btn" data-bag-modal-action="dec" data-id="${esc(bag.id)}">−</button>
            <span class="qty-val">${qty}</span>
            <button type="button" class="qty-btn" data-bag-modal-action="inc" data-id="${esc(bag.id)}">+</button>
          </div>
        </div>
      `;
    }).join('');

    const nonBagCart = cart.filter((entry) => {
      const prod = products.find((p) => p.id === entry.productId);
      return prod && !prod.isBag && prod.category !== MarkerStore.BAGS_CATEGORY;
    });

    const simulatedCart = [...nonBagCart];
    Object.entries(modalBagQuantities).forEach(([bagId, qty]) => {
      if (qty > 0) simulatedCart.push({ productId: bagId, qty });
    });

    const summary = calculateCartSummary(simulatedCart);
    totalEl.textContent = `${MarkerStore.formatMoney(summary.total)} грн`;
  }

  function buildOrderItemsFromCart() {
    const products = MarkerStore.getProducts();
    return cart
      .map((entry) => {
        const prod = products.find((p) => p.id === entry.productId);
        if (!prod) return null;
        return {
          productId: prod.id,
          code: prod.code || '',
          name: prod.name,
          category: prod.category,
          unit: prod.unit,
          price: Number(prod.price) || 0,
          qty: entry.qty,
          status: 'active',
          picked: false,
          isAdult: prod.category === MarkerStore.ADULT_CATEGORY
        };
      })
      .filter(Boolean);
  }

  function finalizeNewOrder(ownBag) {
    const products = MarkerStore.getProducts();

    cart = cart.filter((entry) => {
      const prod = products.find((p) => p.id === entry.productId);
      return prod && !prod.isBag && prod.category !== MarkerStore.BAGS_CATEGORY;
    });

    if (!ownBag) {
      Object.entries(modalBagQuantities).forEach(([bagId, qty]) => {
        if (qty > 0) cart.push({ productId: bagId, qty });
      });
    }

    const name = document.getElementById('customerNameInput').value.trim();
    const phone = document.getElementById('customerPhoneInput').value.trim();
    const comment = document.getElementById('customerCommentInput').value.trim();
    const paymentMethod = document.querySelector('input[name="paymentMethod"]:checked')?.value || 'cash';

    saveProfile(name, phone);
    document.getElementById('cabinetPhoneInput').value = phone;

    const items = buildOrderItemsFromCart();
    if (items.length === 0) return;

    const order = MarkerStore.createOrder({
      customerName: name,
      customerPhone: phone,
      comment,
      paymentMethod,
      ownBag: Boolean(ownBag),
      items
    });

    cart = [];
    saveCart();
    document.getElementById('customerCommentInput').value = '';
    document.getElementById('bagModal').classList.add('hidden');
    closeCartDrawer();
    renderProductsGrid();

    document.getElementById('successOrderCode').textContent = order.code;
    const payNote = document.getElementById('successPaymentNote');
    if (paymentMethod === 'card') {
      const settings = MarkerStore.getSettings();
      payNote.classList.remove('hidden');
      payNote.innerHTML = `
        💳 <strong>Оплата на картку:</strong> ${MarkerStore.escapeHtml(settings.cardNumber || '')}<br>
        Отримувач: ${MarkerStore.escapeHtml(settings.cardRecipient || '')}<br>
        Обов'язково вкажіть код <strong>${MarkerStore.escapeHtml(order.code)}</strong> у призначенні платежу.
      `;
    } else {
      payNote.classList.add('hidden');
    }

    document.getElementById('orderSuccessModal').classList.remove('hidden');
  }

  function handleAppendToActiveOrder() {
    const activeBanner = document.getElementById('activeOrderBanner');
    const activeOrderId = activeBanner.dataset.activeOrderId;
    if (!activeOrderId) return;

    const name = document.getElementById('customerNameInput').value.trim();
    const phone = document.getElementById('customerPhoneInput').value.trim();
    if (name || phone) saveProfile(name, phone);

    const newItems = buildOrderItemsFromCart();
    if (newItems.length === 0) return;

    const updatedOrder = MarkerStore.appendItemsToOrder(activeOrderId, newItems);
    if (!updatedOrder) return;

    cart = [];
    saveCart();
    document.getElementById('customerCommentInput').value = '';
    closeCartDrawer();
    renderProductsGrid();

    document.getElementById('cabinetPhoneInput').value = phone;
    switchMainTab('cabinet');
  }

  // --- КАБІНЕТ КЛІЄНТА ---
  function updateClientSyncIndicator() {
    const state = MarkerStore.getSyncState();
    const indicator = document.getElementById('clientSyncIndicator');
    if (!indicator) return;
    indicator.className = `sync-indicator sync-${state.status}`;
    const textEl = indicator.querySelector('.sync-text');
    if (textEl) textEl.textContent = state.message;
  }

  function renderCabinetView() {
    updateClientSyncIndicator();
    updateHeaderBadges();

    const phoneInput = document.getElementById('cabinetPhoneInput');
    const loyaltyBanner = document.getElementById('loyaltyBanner');
    const ordersListEl = document.getElementById('clientOrdersList');

    const phone = phoneInput.value.trim();
    const norm = MarkerStore.normalizePhone(phone);

    if (!norm) {
      loyaltyBanner.classList.add('hidden');
      ordersListEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📱</div>
          <h3>Введіть номер телефону</h3>
          <p>Вкажіть номер телефону, використаний під час оформлення, щоб переглянути історію та статуси замовлень.</p>
        </div>
      `;
      return;
    }

    const loyalty = MarkerStore.getCustomerLoyalty(phone);
    loyaltyBanner.classList.remove('hidden');
    if (loyalty.isLoyal) {
      loyaltyBanner.innerHTML = `
        <div class="loyalty-active">
          ⭐ <strong>Ви — постійний клієнт MARKET DUO!</strong>
          <span>Успішних замовлень: <strong>${loyalty.successfulCount}</strong>. Ваша автоматична знижка на всі замовлення: <strong>${loyalty.discountPercent}%</strong>.</span>
        </div>
      `;
    } else {
      loyaltyBanner.innerHTML = `
        <div class="loyalty-progress">
          🎁 <strong>Програма лояльності:</strong> у вас <strong>${loyalty.successfulCount}</strong> з <strong>${loyalty.threshold}</strong> замовлень.
          <span>Залишилося ще <strong>${loyalty.remainingToDiscount}</strong>, щоб отримати постійну знижку <strong>${loyalty.discountPercent}%</strong>!</span>
        </div>
      `;
    }

    const clientOrders = MarkerStore.getOrders().filter((o) => o && o.phoneNormalized === norm);

    if (clientOrders.length === 0) {
      ordersListEl.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">📭</div>
          <h3>Замовлень за цим номером не знайдено</h3>
          <p>Перевірте правильність номера телефону або оформіть перше замовлення в каталозі.</p>
        </div>
      `;
      return;
    }

    const esc = MarkerStore.escapeHtml;
    ordersListEl.innerHTML = clientOrders.map((order) => {
      const needsApproval = order.status === 'Очікує підтвердження клієнта';
      const isReady = order.status === 'Готове до видачі';

      const itemsHtml = (order.items || []).map((item) => {
        const isMissing = item.status === 'missing';
        const isReplaced = item.status === 'replaced' && item.replacement;

        if (isMissing) {
          return `
            <li class="client-order-item item-missing">
              <span class="line-through">${esc(item.name)} (${item.qty} ${esc(item.unit)})</span>
              <span class="badge-missing">Немає в наявності</span>
            </li>
          `;
        }

        if (isReplaced) {
          const repSum = Math.round(item.replacement.price * item.replacement.qty * 100) / 100;
          return `
            <li class="client-order-item item-replaced">
              <div>
                <div class="line-through text-muted">${esc(item.name)} (${item.qty} ${esc(item.unit)})</div>
                <div class="replacement-highlight">
                  🔄 <strong>Заміна:</strong> ${esc(item.replacement.name)} — ${item.replacement.qty} ${esc(item.replacement.unit)} × ${MarkerStore.formatMoney(item.replacement.price)} грн
                </div>
              </div>
              <strong>${MarkerStore.formatMoney(repSum)} грн</strong>
            </li>
          `;
        }

        const sum = Math.round(item.price * item.qty * 100) / 100;
        return `
          <li class="client-order-item">
            <span>${esc(item.name)} — ${item.qty} ${esc(item.unit)}</span>
            <strong>${MarkerStore.formatMoney(sum)} грн</strong>
          </li>
        `;
      }).join('');

      return `
        <article class="card client-order-card ${needsApproval ? 'card-needs-approval' : ''}">
          <div class="client-order-top">
            <div>
              <span class="order-code-pill">#${esc(order.code)}</span>
              <span class="order-date">${MarkerStore.formatDateTime(order.timestamp)}</span>
              ${order.ownBag ? '<span class="badge-own-bag">🎒 Зі своїм пакетом</span>' : ''}
            </div>
            <span class="status-badge status-${esc(order.status)}">${esc(order.status)}</span>
          </div>

          <ul class="client-order-items-list">
            ${itemsHtml}
          </ul>

          <div class="client-order-totals">
            ${order.discountPercent > 0 ? `
              <div class="text-success">Знижка постійного клієнта (-${order.discountPercent}%): -${MarkerStore.formatMoney(order.discountAmount)} грн</div>
            ` : ''}
            <div class="client-order-total-sum">Разом до сплати: <strong>${MarkerStore.formatMoney(order.total)} грн</strong></div>
          </div>

          ${needsApproval ? `
            <div class="client-approval-box">
              <p>⚠️ <strong>Магазин вніс зміни у ваше замовлення.</strong> Будь ласка, підтвердіть оновлений склад або скасуйте замовлення:</p>
              <div class="client-approval-actions">
                <button
                  type="button"
                  class="btn btn-success"
                  data-client-action="approve-changes"
                  data-order-id="${esc(order.id)}"
                >✓ Підтвердити зміни</button>
                <button
                  type="button"
                  class="btn btn-danger"
                  data-client-action="cancel-order"
                  data-order-id="${esc(order.id)}"
                >✕ Скасувати замовлення</button>
              </div>
            </div>
          ` : ''}

          ${isReady ? `
            <div class="client-approaching-box">
              ${order.clientApproaching ? `
                <div class="approaching-sent-msg">
                  ✅ Ви повідомили продавця, що підходите (о ${esc(order.clientApproachingTime || '')}). Очікуємо на видачі!
                </div>
              ` : `
                <button
                  type="button"
                  class="btn btn-warning btn-block"
                  data-client-action="approaching"
                  data-order-id="${esc(order.id)}"
                >🚶 Я підходжу / біля магазину</button>
              `}
            </div>
          ` : ''}
        </article>
      `;
    }).join('');
  }

  // --- Прив'язка всіх подій вітрини ---
  function bindEvents() {
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchMainTab(btn.dataset.tab));
    });

    document.getElementById('brandHomeLink').addEventListener('click', (e) => {
      e.preventDefault();
      selectedCategory = 'all';
      switchMainTab('catalog');
    });

    const searchInput = document.getElementById('searchInput');
    const clearSearchBtn = document.getElementById('clearSearchBtn');
    searchInput.addEventListener('input', () => {
      searchQuery = searchInput.value.trim();
      clearSearchBtn.classList.toggle('hidden', !searchQuery);
      renderProductsGrid();
    });

    clearSearchBtn.addEventListener('click', () => {
      searchQuery = '';
      searchInput.value = '';
      clearSearchBtn.classList.add('hidden');
      renderProductsGrid();
    });

    document.getElementById('categoryChips').addEventListener('click', (e) => {
      const chip = e.target.closest('[data-cat]');
      if (!chip) return;
      selectedCategory = chip.dataset.cat;
      renderCategoryChips();
      renderProductsGrid();
    });

    document.getElementById('productsGrid').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn) return;
      const action = btn.dataset.action;
      const id = btn.dataset.id;

      if (action === 'toggle-fav') {
        if (favorites.has(id)) favorites.delete(id);
        else favorites.add(id);
        saveFavorites();
        renderCategoryChips();
        renderProductsGrid();
      } else if (action === 'cart-add') {
        addToCart(id);
      } else if (action === 'cart-inc') {
        changeCartQty(id, 1);
      } else if (action === 'cart-dec') {
        changeCartQty(id, -1);
      }
    });

    document.getElementById('openCartBtn').addEventListener('click', openCartDrawer);
    document.getElementById('closeCartBtn').addEventListener('click', closeCartDrawer);
    document.getElementById('cartBackdrop').addEventListener('click', closeCartDrawer);

    document.getElementById('cartDrawerBody').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cart-action]');
      if (!btn) return;
      const action = btn.dataset.cartAction;
      const id = btn.dataset.id;

      if (action === 'add') addToCart(id);
      else if (action === 'inc') changeCartQty(id, 1);
      else if (action === 'dec') changeCartQty(id, -1);
    });

    document.getElementById('customerPhoneInput').addEventListener('input', () => {
      updateCartCheckoutState();
    });

    document.getElementById('customerNameInput').addEventListener('blur', () => {
      saveProfile(
        document.getElementById('customerNameInput').value,
        document.getElementById('customerPhoneInput').value
      );
    });

    document.getElementById('appendToActiveOrderBtn').addEventListener('click', handleAppendToActiveOrder);

    document.querySelectorAll('input[name="paymentMethod"]').forEach((radio) => {
      radio.addEventListener('change', (e) => {
        const isCard = e.target.value === 'card';
        document.getElementById('cardPaymentBox').classList.toggle('hidden', !isCard);
        if (isCard) updateCartCheckoutState();
      });
    });

    document.getElementById('copyCardBtn').addEventListener('click', () => {
      const num = document.getElementById('displayCardNumber').textContent;
      navigator.clipboard?.writeText(num);
      const btn = document.getElementById('copyCardBtn');
      btn.textContent = 'Скопійовано!';
      setTimeout(() => (btn.textContent = 'Копіювати'), 1800);
    });

    document.getElementById('copyOrderCodeBtn').addEventListener('click', () => {
      const code = document.getElementById('previewOrderCode').textContent;
      navigator.clipboard?.writeText(code);
      const btn = document.getElementById('copyOrderCodeBtn');
      btn.textContent = 'Скопійовано!';
      setTimeout(() => (btn.textContent = 'Копіювати'), 1800);
    });

    document.getElementById('checkoutForm').addEventListener('submit', (e) => {
      e.preventDefault();
      if (cart.length === 0) return;
      openBagSelectionModal();
    });

    document.getElementById('confirmAgeBtn').addEventListener('click', () => {
      setAgeVerified();
      document.getElementById('ageModal').classList.add('hidden');
      switchMainTab('adult');
    });

    document.getElementById('cancelAgeBtn').addEventListener('click', () => {
      document.getElementById('ageModal').classList.add('hidden');
    });

    document.getElementById('closeBagModalBtn').addEventListener('click', () => {
      document.getElementById('bagModal').classList.add('hidden');
    });

    document.getElementById('bagModalList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-bag-modal-action]');
      if (!btn) return;
      const action = btn.dataset.bagModalAction;
      const id = btn.dataset.id;
      const current = modalBagQuantities[id] || 0;
      modalBagQuantities[id] = action === 'inc' ? current + 1 : Math.max(0, current - 1);
      renderBagModalContent();
    });

    document.getElementById('confirmWithBagsBtn').addEventListener('click', () => {
      const totalSelectedBags = Object.values(modalBagQuantities).reduce((s, q) => s + q, 0);
      if (totalSelectedBags <= 0) {
        alert('Оберіть хоча б 1 пакет або натисніть «Я прийду зі своїм пакетом».');
        return;
      }
      finalizeNewOrder(false);
    });

    document.getElementById('confirmOwnBagBtn').addEventListener('click', () => {
      finalizeNewOrder(true);
    });

    document.getElementById('closeSuccessModalBtn').addEventListener('click', () => {
      document.getElementById('orderSuccessModal').classList.add('hidden');
    });

    document.getElementById('goToCabinetAfterOrderBtn').addEventListener('click', () => {
      document.getElementById('orderSuccessModal').classList.add('hidden');
      switchMainTab('cabinet');
    });

    document.getElementById('cabinetSearchForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const phone = document.getElementById('cabinetPhoneInput').value.trim();
      if (phone) {
        let existingName = '';
        try {
          existingName = JSON.parse(readClientStorage(PROFILE_KEY) || '{}').name || '';
        } catch (err) {
          existingName = '';
        }
        saveProfile(existingName, phone);
        const cartPhone = document.getElementById('customerPhoneInput');
        if (cartPhone && !cartPhone.value.trim()) cartPhone.value = phone;
      }
      renderCabinetView();
    });

    document.getElementById('clientOrdersList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-client-action]');
      if (!btn) return;

      const action = btn.dataset.clientAction;
      const orderId = btn.dataset.orderId;

      if (action === 'approve-changes') {
        MarkerStore.updateOrder(orderId, (ord) => {
          ord.status = 'Комплектується';
          ord.clientConfirmedChanges = true;
        });
        renderCabinetView();
      } else if (action === 'cancel-order') {
        if (!confirm('Ви впевнені, що бажаєте скасувати це замовлення?')) return;
        MarkerStore.updateOrder(orderId, (ord) => {
          ord.status = 'Відхилено';
        });
        renderCabinetView();
      } else if (action === 'approaching') {
        const timeStr = new Date().toLocaleTimeString('uk-UA', {
          hour: '2-digit',
          minute: '2-digit'
        });
        MarkerStore.updateOrder(orderId, (ord) => {
          ord.clientApproaching = true;
          ord.clientApproachingTime = timeStr;
        });
        renderCabinetView();
      }
    });

    window.addEventListener('markerstore:updated', () => {
      updateClientSyncIndicator();
      updateHeaderBadges();
    });
  }

  async function initApp() {
    MarkerStore.init();
    loadClientState();
    bindEvents();

    updateHeaderBadges();
    renderCategoryChips();
    renderProductsGrid();

    await MarkerStore.syncFromCloud();
    updateHeaderBadges();
    renderCategoryChips();
    renderProductsGrid();
    if (currentMainTab === 'cabinet') {
      renderCabinetView();
    }

    // Фонове оновлення з хмари кожні 4 секунди
    if (cabinetSyncTimer) clearInterval(cabinetSyncTimer);
    cabinetSyncTimer = setInterval(async () => {
      const synced = await MarkerStore.syncFromCloud();
      if (synced) {
        updateHeaderBadges();
        if (currentMainTab === 'cabinet') {
          renderCabinetView();
        } else {
          renderProductsGrid();
        }
      }
    }, 4000);
  }

  document.addEventListener('DOMContentLoaded', initApp);
})();
