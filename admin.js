(function () {
  'use strict';

  const AUTH_SESSION_KEY = 'market_duo_admin_auth';
  let activeAdminTab = 'orders';
  let knownOrderIds = new Set();
  let initialOrdersLoaded = false;
  let pendingProdImageBase64 = '';
  let pendingBagImageBase64 = '';
  let currentMissingContext = null; // { orderId, itemIndex }
  let autoSyncTimer = null;
  let dashboardInitialized = false;
  let memoryAuthFlag = false;

  const ORDER_STATUSES = [
    'Розміщено',
    'Очікує підтвердження клієнта',
    'Комплектується',
    'Готове до видачі',
    'Виконано успішно',
    'Відхилено'
  ];

  // --- Безпечна робота з сесією авторизації ---
  function getAuthSession() {
    if (memoryAuthFlag) return true;
    try {
      return sessionStorage.getItem(AUTH_SESSION_KEY) === 'true';
    } catch (e) {
      return memoryAuthFlag;
    }
  }

  function setAuthSession(isAuth) {
    memoryAuthFlag = Boolean(isAuth);
    try {
      if (isAuth) {
        sessionStorage.setItem(AUTH_SESSION_KEY, 'true');
      } else {
        sessionStorage.removeItem(AUTH_SESSION_KEY);
      }
    } catch (e) {
      // Резерв через memoryAuthFlag для мобільних WebView
    }
  }

  // --- Утиліти сповіщень та звуку ---
  function playNewOrderChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const now = ctx.currentTime;

      const osc1 = ctx.createOscillator();
      const gain1 = ctx.createGain();
      osc1.type = 'sine';
      osc1.frequency.setValueAtTime(587.33, now);
      gain1.gain.setValueAtTime(0.18, now);
      gain1.gain.exponentialRampToValueAtTime(0.001, now + 0.25);
      osc1.connect(gain1);
      gain1.connect(ctx.destination);
      osc1.start(now);
      osc1.stop(now + 0.25);

      const osc2 = ctx.createOscillator();
      const gain2 = ctx.createGain();
      osc2.type = 'sine';
      osc2.frequency.setValueAtTime(880, now + 0.18);
      gain2.gain.setValueAtTime(0.22, now + 0.18);
      gain2.gain.exponentialRampToValueAtTime(0.001, now + 0.55);
      osc2.connect(gain2);
      gain2.connect(ctx.destination);
      osc2.start(now + 0.18);
      osc2.stop(now + 0.55);
    } catch (e) {
      // Ігноруємо обмеження автозапуску аудіо до першої взаємодії
    }
  }

  function showToast(message, type = 'info') {
    const container = document.getElementById('adminToastContainer');
    if (!container) return;
    const toast = document.createElement('div');
    toast.className = `admin-toast toast-${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-hide');
      setTimeout(() => toast.remove(), 300);
    }, 4500);
  }

  // --- Перевірка протоколу та авторизація ---
  function checkFileProtocol() {
    if (window.location.protocol === 'file:') {
      const banner = document.getElementById('fileProtocolWarning');
      if (banner) banner.classList.remove('hidden');
    }
  }

  function isAuthenticated() {
    return getAuthSession();
  }

  function initAuth() {
    const loginScreen = document.getElementById('adminLoginScreen');
    const dashboard = document.getElementById('adminDashboard');
    const loginForm = document.getElementById('adminLoginForm');
    const passwordInput = document.getElementById('adminPasswordInput');
    const togglePassBtn = document.getElementById('toggleAdminPassBtn');
    const loginError = document.getElementById('adminLoginError');
    const loginBtn = document.getElementById('adminLoginBtn');
    const logoutBtn = document.getElementById('adminLogoutBtn');

    if (togglePassBtn && passwordInput) {
      togglePassBtn.addEventListener('click', () => {
        const isPassword = passwordInput.type === 'password';
        passwordInput.type = isPassword ? 'text' : 'password';
        togglePassBtn.textContent = isPassword ? '🙈' : '👁️';
      });
    }

    if (isAuthenticated()) {
      loginScreen.classList.add('hidden');
      dashboard.classList.remove('hidden');
      startDashboard();
    } else {
      loginScreen.classList.remove('hidden');
      dashboard.classList.add('hidden');
      // Підтягуємо актуальні налаштування (у т.ч. пароль) з Firebase у фоні
      MarkerStore.syncFromCloud().catch(() => {});
    }

    let isSubmittingLogin = false;

    async function handleLoginAttempt(e) {
      if (e) e.preventDefault();
      if (isSubmittingLogin) return;

      const entered = String(passwordInput.value || '').trim();
      if (!entered) {
        loginError.textContent = 'Введіть пароль адміністратора.';
        loginError.classList.remove('hidden');
        passwordInput.focus();
        return;
      }

      isSubmittingLogin = true;
      loginError.classList.add('hidden');
      const originalBtnText = loginBtn ? loginBtn.textContent : 'Увійти в панель';
      if (loginBtn) {
        loginBtn.disabled = true;
        loginBtn.textContent = 'Перевірка...';
      }

      try {
        // Синхронізуємо налаштування з хмари, щоб актуальний пароль діяв і на телефоні
        await MarkerStore.syncFromCloud();
      } catch (err) {
        // Якщо хмара тимчасово недоступна — перевіряємо за локальним паролем
      }

      const settings = MarkerStore.getSettings();
      const validPass = String(settings.adminPassword || '1111').trim();

      if (entered === validPass) {
        setAuthSession(true);
        passwordInput.value = '';
        loginScreen.classList.add('hidden');
        dashboard.classList.remove('hidden');
        startDashboard();
      } else {
        loginError.textContent = 'Невірний пароль. Спробуйте ще раз.';
        loginError.classList.remove('hidden');
      }

      if (loginBtn) {
        loginBtn.disabled = false;
        loginBtn.textContent = originalBtnText;
      }
      isSubmittingLogin = false;
    }

    loginForm.addEventListener('submit', handleLoginAttempt);
    if (loginBtn) {
      loginBtn.addEventListener('click', (e) => {
        if (loginForm.checkValidity()) {
          handleLoginAttempt(e);
        }
      });
    }

    logoutBtn.addEventListener('click', () => {
      setAuthSession(false);
      if (autoSyncTimer) clearInterval(autoSyncTimer);
      dashboard.classList.add('hidden');
      loginScreen.classList.remove('hidden');
    });
  }

  // --- Синхронізація та сповіщення про нові замовлення ---
  function updateSyncIndicator() {
    const state = MarkerStore.getSyncState();
    const indicator = document.getElementById('adminSyncIndicator');
    const textEl = document.getElementById('adminSyncText');
    const settingsInfo = document.getElementById('settingsSyncInfo');

    if (indicator && textEl) {
      indicator.className = `sync-indicator sync-${state.status}`;
      textEl.textContent = state.message;
    }
    if (settingsInfo) {
      settingsInfo.textContent = `Статус підключення: ${state.message}`;
    }
  }

  function checkForNewOrders(orders) {
    if (!initialOrdersLoaded) {
      orders.forEach((o) => knownOrderIds.add(o.id));
      initialOrdersLoaded = true;
      return;
    }

    let hasNewPlacedOrder = false;
    orders.forEach((order) => {
      if (!knownOrderIds.has(order.id)) {
        knownOrderIds.add(order.id);
        if (order.status === 'Розміщено') {
          hasNewPlacedOrder = true;
          showToast(`🔔 Нове замовлення #${order.code} від ${order.customerName}!`, 'success');
        }
      }
    });

    if (hasNewPlacedOrder) {
      playNewOrderChime();
    }
  }

  // --- KPI та навігація вкладок ---
  function renderKPIs() {
    const orders = MarkerStore.getOrders();
    const products = MarkerStore.getProducts();

    const newOrdersCount = orders.filter((o) => o.status === 'Розміщено').length;
    const acceptedRevenue = orders
      .filter((o) => o.status !== 'Відхилено')
      .reduce((sum, o) => sum + (Number(o.total) || 0), 0);

    document.getElementById('kpiNewOrders').textContent = String(newOrdersCount);
    document.getElementById('kpiTotalOrders').textContent = String(orders.length);
    document.getElementById('kpiAcceptedRevenue').textContent = `${MarkerStore.formatMoney(acceptedRevenue)} грн`;
    document.getElementById('kpiTotalProducts').textContent = String(products.length);

    const badge = document.getElementById('tabNewOrdersBadge');
    if (badge) {
      badge.textContent = String(newOrdersCount);
      badge.classList.toggle('badge-alert-active', newOrdersCount > 0);
    }
  }

  function switchAdminTab(tabName) {
    activeAdminTab = tabName;
    document.querySelectorAll('.admin-tab').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.adminTab === tabName);
    });
    document.querySelectorAll('.admin-tab-panel').forEach((panel) => {
      const isMatch = panel.id === `tab-${tabName}`;
      panel.classList.toggle('active', isMatch);
      panel.classList.toggle('hidden', !isMatch);
    });

    renderCurrentTab();
  }

  function renderCurrentTab() {
    renderKPIs();
    updateSyncIndicator();

    if (activeAdminTab === 'orders') renderOrdersTab();
    else if (activeAdminTab === 'products') renderProductsTab();
    else if (activeAdminTab === 'bags') renderBagsTab();
    else if (activeAdminTab === 'categories') renderCategoriesTab();
    else if (activeAdminTab === 'reports') renderReportsTab();
    else if (activeAdminTab === 'settings') renderSettingsTab();
  }

  // --- ВКЛАДКА 1: ЗАМОВЛЕННЯ ---
  function renderOrdersTab() {
    const container = document.getElementById('adminOrdersList');
    if (!container) return;

    const searchQuery = (document.getElementById('orderSearchInput')?.value || '').trim().toLowerCase();
    const statusFilter = document.getElementById('orderStatusFilter')?.value || 'all';

    let orders = [...MarkerStore.getOrders()];

    if (statusFilter !== 'all') {
      orders = orders.filter((o) => o.status === statusFilter);
    }

    if (searchQuery) {
      orders = orders.filter((o) => {
        const code = String(o.code || '').toLowerCase();
        const name = String(o.customerName || '').toLowerCase();
        const phone = String(o.customerPhone || '').toLowerCase();
        const norm = String(o.phoneNormalized || '').toLowerCase();
        return code.includes(searchQuery) || name.includes(searchQuery) || phone.includes(searchQuery) || norm.includes(searchQuery);
      });
    }

    // Пріоритетне сортування: замовлення "Я підходжу" у статусі "Готове до видачі" завжди зверху
    orders.sort((a, b) => {
      const aPriority = a.status === 'Готове до видачі' && a.clientApproaching ? 1 : 0;
      const bPriority = b.status === 'Готове до видачі' && b.clientApproaching ? 1 : 0;
      if (aPriority !== bPriority) return bPriority - aPriority;
      return (b.timestamp || 0) - (a.timestamp || 0);
    });

    if (orders.length === 0) {
      container.innerHTML = `
        <div class="empty-state card">
          <div class="empty-icon">📋</div>
          <h3>Замовлень не знайдено</h3>
          <p>Змініть фільтр або дочекайтеся нових замовлень від покупців.</p>
        </div>
      `;
      return;
    }

    const esc = MarkerStore.escapeHtml;

    container.innerHTML = orders.map((order) => {
      const isApproaching = order.status === 'Готове до видачі' && order.clientApproaching;
      const hasAdultItems = (order.items || []).some(
        (it) => it.category === MarkerStore.ADULT_CATEGORY || it.isAdult
      );

      const countableItems = (order.items || []).filter((it) => it.status !== 'missing');
      const pickedCount = countableItems.filter((it) => it.picked).length;

      const hasPendingChanges = (order.items || []).some(
        (it) => it.status === 'missing' || it.status === 'replaced'
      );
      const showSendApprovalBtn =
        hasPendingChanges &&
        order.status !== 'Очікує підтвердження клієнта' &&
        order.status !== 'Виконано успішно' &&
        order.status !== 'Відхилено' &&
        !order.clientConfirmedChanges;

      const statusOptionsHtml = ORDER_STATUSES.map(
        (st) => `<option value="${esc(st)}" ${order.status === st ? 'selected' : ''}>${esc(st)}</option>`
      ).join('');

      const itemsHtml = (order.items || []).map((item, idx) => {
        const isMissing = item.status === 'missing';
        const isReplaced = item.status === 'replaced' && item.replacement;
        const effectiveItem = isReplaced ? item.replacement : item;
        const lineTotal = isMissing
          ? 0
          : Math.round((Number(effectiveItem.price) || 0) * (Number(effectiveItem.qty) || 0) * 100) / 100;

        return `
          <div class="admin-order-item ${isMissing ? 'item-missing' : ''} ${isReplaced ? 'item-replaced' : ''}">
            <div class="order-item-left">
              ${!isMissing ? `
                <input
                  type="checkbox"
                  class="pick-checkbox"
                  data-action="toggle-pick"
                  data-order-id="${esc(order.id)}"
                  data-item-index="${idx}"
                  ${item.picked ? 'checked' : ''}
                  title="Позначити як зібрано"
                >
              ` : '<span class="missing-icon">✕</span>'}

              <div class="order-item-details">
                <div class="order-item-title-row">
                  ${effectiveItem.code ? `<span class="code-1c-badge">Код: ${esc(effectiveItem.code)}</span>` : ''}
                  <span class="${isMissing ? 'line-through' : 'item-name-bold'}">${esc(item.name)}</span>
                  ${item.category === MarkerStore.ADULT_CATEGORY ? '<span class="badge-18">18+</span>' : ''}
                </div>

                ${isReplaced ? `
                  <div class="replacement-info-line">
                    🔄 <strong>Заміна:</strong>
                    ${item.replacement.code ? `<span class="code-1c-badge">Код: ${esc(item.replacement.code)}</span>` : ''}
                    <span>${esc(item.replacement.name)}</span>
                    (${item.replacement.qty} ${esc(item.replacement.unit)} × ${MarkerStore.formatMoney(item.replacement.price)} грн)
                  </div>
                ` : `
                  <div class="order-item-meta">
                    ${item.qty} ${esc(item.unit)} × ${MarkerStore.formatMoney(item.price)} грн
                    ${isMissing ? '<span class="status-tag tag-danger">Відсутній</span>' : ''}
                  </div>
                `}
              </div>
            </div>

            <div class="order-item-right">
              <strong class="order-item-sum">${MarkerStore.formatMoney(lineTotal)} грн</strong>
              ${!isMissing && order.status !== 'Виконано успішно' && order.status !== 'Відхилено' ? `
                <div class="order-item-actions">
                  <button
                    type="button"
                    class="btn btn-xs btn-secondary"
                    data-action="edit-weight"
                    data-order-id="${esc(order.id)}"
                    data-item-index="${idx}"
                  >⚖️ Вага / к-сть</button>
                  <button
                    type="button"
                    class="btn btn-xs btn-outline-danger"
                    data-action="open-missing"
                    data-order-id="${esc(order.id)}"
                    data-item-index="${idx}"
                  >Немає в наявності</button>
                </div>
              ` : ''}
            </div>
          </div>
        `;
      }).join('');

      return `
        <article class="card admin-order-card status-border-${esc(order.status)} ${isApproaching ? 'order-approaching-highlight' : ''}">
          ${isApproaching ? `
            <div class="approaching-banner">
              <div>
                🚶 <strong>КЛІЄНТ ПІДХОДИТЬ / БІЛЯ МАГАЗИНУ!</strong>
                ${order.clientApproachingTime ? `<span>(Сигнал о ${esc(order.clientApproachingTime)})</span>` : ''}
              </div>
              <button
                type="button"
                class="btn btn-xs btn-dark"
                data-action="clear-approaching"
                data-order-id="${esc(order.id)}"
              >Зняти сигнал</button>
            </div>
          ` : ''}

          <div class="admin-order-header">
            <div class="order-id-block">
              <span class="order-code-pill">#${esc(order.code)}</span>
              <span class="order-time">${MarkerStore.formatDateTime(order.timestamp)}</span>
              ${order.ownBag ? '<span class="badge-own-bag">🎒 Зі своїм пакетом</span>' : ''}
              ${hasAdultItems ? '<span class="badge-adult-doc">🔞 18+ Документ</span>' : ''}
            </div>

            <div class="order-status-control">
              <select
                class="form-select form-select-status"
                data-action="change-status"
                data-order-id="${esc(order.id)}"
                aria-label="Статус замовлення #${esc(order.code)}"
              >
                ${statusOptionsHtml}
              </select>
            </div>
          </div>

          <div class="admin-order-customer">
            <div>
              <strong>👤 ${esc(order.customerName)}</strong> —
              <a href="tel:${esc(order.customerPhone)}" class="phone-link">📞 ${esc(order.customerPhone)}</a>
            </div>
            <div class="payment-tag">
              ${order.paymentMethod === 'card'
                ? '💳 <strong>Оплата на картку</strong> (звірити код #' + esc(order.code) + ')'
                : '💵 Оплата при отриманні'}
            </div>
          </div>

          ${order.comment ? `
            <div class="order-comment-box">
              💬 <strong>Коментар клієнта:</strong> ${esc(order.comment)}
            </div>
          ` : ''}

          ${order.addedNote ? `
            <div class="order-added-note">
              ➕ <strong>Дозамовлення:</strong> ${esc(order.addedNote)}
            </div>
          ` : ''}

          <div class="picking-progress-bar">
            <span>✓ Зібрано: <strong>${pickedCount} з ${countableItems.length}</strong></span>
          </div>

          <div class="admin-order-items">
            ${itemsHtml}
          </div>

          ${showSendApprovalBtn ? `
            <div class="approval-prompt-box">
              <span>Позиції замовлення змінено. Надішліть оновлений склад клієнту:</span>
              <button
                type="button"
                class="btn btn-warning"
                data-action="send-approval"
                data-order-id="${esc(order.id)}"
              >📩 Надіслати зміни на погодження клієнту</button>
            </div>
          ` : ''}

          <div class="admin-order-footer">
            <div class="order-totals-summary">
              <span>Сума: ${MarkerStore.formatMoney(order.subtotal)} грн</span>
              ${order.discountPercent > 0 ? `
                <span class="text-success">Знижка (${order.discountPercent}%): -${MarkerStore.formatMoney(order.discountAmount)} грн</span>
              ` : ''}
              <strong class="order-final-sum">До сплати: ${MarkerStore.formatMoney(order.total)} грн</strong>
            </div>
          </div>
        </article>
      `;
    }).join('');
  }

  function handleOrdersListClick(e) {
    const target = e.target.closest('[data-action]');
    if (!target) return;

    const action = target.dataset.action;
    const orderId = target.dataset.orderId;
    const itemIndex = Number(target.dataset.itemIndex);

    if (action === 'clear-approaching') {
      MarkerStore.updateOrder(orderId, (ord) => {
        ord.clientApproaching = false;
        ord.clientApproachingTime = '';
      });
      renderOrdersTab();
      showToast('Сигнал клієнта знято.');
    } else if (action === 'edit-weight') {
      const order = MarkerStore.getOrders().find((o) => o.id === orderId);
      if (!order || !order.items[itemIndex]) return;

      const item = order.items[itemIndex];
      const isReplaced = item.status === 'replaced' && item.replacement;
      const currentQty = isReplaced ? item.replacement.qty : item.qty;
      const unitLabel = isReplaced ? item.replacement.unit : item.unit;

      const input = prompt(`Введіть фактичну вагу або кількість (${unitLabel}):`, String(currentQty));
      if (input === null) return;
      const parsed = parseFloat(input.replace(',', '.'));
      if (isNaN(parsed) || parsed <= 0) {
        alert('Введіть коректне число більше 0.');
        return;
      }

      const roundedQty = Math.round(parsed * 1000) / 1000;
      MarkerStore.updateOrder(orderId, (ord) => {
        const targetItem = ord.items[itemIndex];
        if (targetItem.status === 'replaced' && targetItem.replacement) {
          targetItem.replacement.qty = roundedQty;
        } else {
          targetItem.qty = roundedQty;
        }
        MarkerStore.recalculateOrderTotals(ord);
      });
      renderOrdersTab();
      renderKPIs();
      showToast(`Кількість оновлено до ${roundedQty} ${unitLabel}`);
    } else if (action === 'open-missing') {
      openMissingItemModal(orderId, itemIndex);
    } else if (action === 'send-approval') {
      MarkerStore.updateOrder(orderId, (ord) => {
        ord.status = 'Очікує підтвердження клієнта';
        ord.clientConfirmedChanges = false;
      });
      renderOrdersTab();
      renderKPIs();
      showToast('Запит на погодження змін надіслано клієнту!', 'success');
    }
  }

  function handleOrdersListChange(e) {
    const target = e.target;
    const action = target.dataset.action;
    if (!action) return;

    const orderId = target.dataset.orderId;

    if (action === 'change-status') {
      const newStatus = target.value;
      MarkerStore.updateOrder(orderId, (ord) => {
        ord.status = newStatus;
        if (newStatus !== 'Готове до видачі') {
          ord.clientApproaching = false;
        }
      });
      renderOrdersTab();
      renderKPIs();
      showToast(`Статус замовлення змінено на «${newStatus}»`);
    } else if (action === 'toggle-pick') {
      const itemIndex = Number(target.dataset.itemIndex);
      MarkerStore.updateOrder(orderId, (ord) => {
        if (ord.items[itemIndex]) {
          ord.items[itemIndex].picked = target.checked;
        }
      });
      renderOrdersTab();
    }
  }

  // --- Модальне вікно відсутнього товару та заміни ---
  function openMissingItemModal(orderId, itemIndex) {
    const order = MarkerStore.getOrders().find((o) => o.id === orderId);
    if (!order || !order.items[itemIndex]) return;

    currentMissingContext = { orderId, itemIndex };
    const item = order.items[itemIndex];

    document.getElementById('missingItemTitle').textContent =
      `${item.code ? '[' + item.code + '] ' : ''}${item.name} (${item.qty} ${item.unit})`;
    document.getElementById('markProductOutOfStockCheckbox').checked = true;
    document.getElementById('replacementSearchInput').value = '';
    document.getElementById('replacementQtyInput').value = String(item.qty || 1);

    renderReplacementCandidates();
    document.getElementById('missingItemModal').classList.remove('hidden');
  }

  function closeMissingItemModal() {
    currentMissingContext = null;
    document.getElementById('missingItemModal').classList.add('hidden');
  }

  function renderReplacementCandidates() {
    const listEl = document.getElementById('replacementCandidatesList');
    if (!listEl) return;

    const query = (document.getElementById('replacementSearchInput').value || '').trim().toLowerCase();
    const products = MarkerStore.getProducts().filter((p) => p.inStock !== false);

    const filtered = query
      ? products.filter(
          (p) =>
            String(p.name || '').toLowerCase().includes(query) ||
            String(p.code || '').toLowerCase().includes(query)
        )
      : products.slice(0, 20);

    if (filtered.length === 0) {
      listEl.innerHTML = '<p class="text-muted">Товарів на заміну не знайдено.</p>';
      return;
    }

    const esc = MarkerStore.escapeHtml;
    listEl.innerHTML = filtered.map((prod) => `
      <div class="replacement-candidate-row">
        <div>
          ${prod.code ? `<span class="code-1c-badge">${esc(prod.code)}</span>` : ''}
          <strong>${esc(prod.name)}</strong>
          <span class="text-muted">(${esc(prod.unit)} — ${MarkerStore.formatMoney(prod.price)} грн)</span>
        </div>
        <button
          type="button"
          class="btn btn-xs btn-primary"
          data-select-replacement-id="${esc(prod.id)}"
        >Обрати заміну</button>
      </div>
    `).join('');
  }

  function applyMissingOrReplacement(replacementProduct) {
    if (!currentMissingContext) return;
    const { orderId, itemIndex } = currentMissingContext;
    const markCatalogOutOfStock = document.getElementById('markProductOutOfStockCheckbox').checked;
    const repQty = parseFloat(document.getElementById('replacementQtyInput').value) || 1;

    const order = MarkerStore.getOrders().find((o) => o.id === orderId);
    if (!order || !order.items[itemIndex]) return;

    const originalProductId = order.items[itemIndex].productId;

    if (markCatalogOutOfStock && originalProductId) {
      MarkerStore.updateProduct(originalProductId, { inStock: false });
    }

    MarkerStore.updateOrder(orderId, (ord) => {
      const targetItem = ord.items[itemIndex];
      if (replacementProduct) {
        targetItem.status = 'replaced';
        targetItem.picked = false;
        targetItem.replacement = {
          productId: replacementProduct.id,
          code: replacementProduct.code || '',
          name: replacementProduct.name,
          unit: replacementProduct.unit,
          price: Number(replacementProduct.price) || 0,
          qty: repQty
        };
      } else {
        targetItem.status = 'missing';
        targetItem.picked = false;
        delete targetItem.replacement;
      }
      ord.clientConfirmedChanges = false;
      MarkerStore.recalculateOrderTotals(ord);
    });

    closeMissingItemModal();
    renderOrdersTab();
    renderKPIs();
    showToast(
      replacementProduct
        ? `Запропоновано заміну: ${replacementProduct.name}`
        : 'Позицію позначено як відсутню.'
    );
  }

  // --- ВКЛАДКА 2: ТОВАРИ ---
  function populateCategoriesDatalist() {
    const datalist = document.getElementById('categoriesDatalist');
    const filterSelect = document.getElementById('adminProductCategoryFilter');
    const categories = MarkerStore.getCategories();

    if (datalist) {
      datalist.innerHTML = categories
        .filter((c) => c.name !== MarkerStore.BAGS_CATEGORY)
        .map((c) => `<option value="${MarkerStore.escapeHtml(c.name)}">`)
        .join('');
    }

    if (filterSelect) {
      const prev = filterSelect.value;
      filterSelect.innerHTML =
        '<option value="all">Усі категорії</option>' +
        categories
          .map((c) => `<option value="${MarkerStore.escapeHtml(c.name)}">${MarkerStore.escapeHtml(c.name)}</option>`)
          .join('');
      if ([...filterSelect.options].some((o) => o.value === prev)) {
        filterSelect.value = prev;
      }
    }
  }

  function renderProductsTab() {
    populateCategoriesDatalist();

    const listEl = document.getElementById('adminProductsList');
    if (!listEl) return;

    const query = (document.getElementById('adminProductSearchInput')?.value || '').trim().toLowerCase();
    const catFilter = document.getElementById('adminProductCategoryFilter')?.value || 'all';

    let products = MarkerStore.getProducts().filter(
      (p) => !p.isBag && p.category !== MarkerStore.BAGS_CATEGORY
    );

    if (catFilter !== 'all') {
      products = products.filter((p) => p.category === catFilter);
    }

    if (query) {
      products = products.filter(
        (p) =>
          String(p.name || '').toLowerCase().includes(query) ||
          String(p.code || '').toLowerCase().includes(query)
      );
    }

    if (products.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state card">
          <div class="empty-icon">📦</div>
          <h3>Товарів не знайдено</h3>
          <p>Додайте перший товар через форму вище або змініть параметри пошуку.</p>
        </div>
      `;
      return;
    }

    const esc = MarkerStore.escapeHtml;
    listEl.innerHTML = products.map((prod) => `
      <div class="card admin-item-row ${prod.inStock === false ? 'item-row-out' : ''}">
        <div class="admin-item-info">
          <div class="admin-item-thumb">
            ${prod.image
              ? `<img src="${esc(prod.image)}" alt="${esc(prod.name)}">`
              : `<span>${esc(prod.emoji || '📦')}</span>`}
          </div>
          <div>
            <div class="admin-item-title">
              ${prod.code ? `<span class="code-1c-badge">Код: ${esc(prod.code)}</span>` : '<span class="code-1c-badge badge-muted">Без коду</span>'}
              <strong>${esc(prod.name)}</strong>
              ${prod.category === MarkerStore.ADULT_CATEGORY ? '<span class="badge-18">18+</span>' : ''}
            </div>
            <div class="admin-item-meta">
              Категорія: <strong>${esc(prod.category)}</strong> • Од.: ${esc(prod.unit)}
              ${prod.capacity ? ` • ${esc(prod.capacity)}` : ''}
            </div>
          </div>
        </div>

        <div class="admin-item-controls">
          <strong class="admin-item-price">${MarkerStore.formatMoney(prod.price)} грн</strong>

          <button
            type="button"
            class="btn btn-xs btn-secondary"
            data-prod-action="edit-code"
            data-id="${esc(prod.id)}"
          >Код 1С</button>

          <button
            type="button"
            class="btn btn-xs btn-secondary"
            data-prod-action="edit-price"
            data-id="${esc(prod.id)}"
          >Ціна</button>

          <button
            type="button"
            class="btn btn-xs ${prod.inStock !== false ? 'btn-success' : 'btn-warning'}"
            data-prod-action="toggle-stock"
            data-id="${esc(prod.id)}"
          >${prod.inStock !== false ? '✓ В наявності' : '✕ Немає'}</button>

          <button
            type="button"
            class="btn btn-xs btn-danger"
            data-prod-action="delete"
            data-id="${esc(prod.id)}"
            title="Видалити товар"
          >🗑️</button>
        </div>
      </div>
    `).join('');
  }

  // --- ВКЛАДКА 3: ПАКЕТИ ---
  function renderBagsTab() {
    const listEl = document.getElementById('adminBagsList');
    if (!listEl) return;

    const bags = MarkerStore.getProducts().filter(
      (p) => p.isBag || p.category === MarkerStore.BAGS_CATEGORY
    );

    if (bags.length === 0) {
      listEl.innerHTML = `
        <div class="empty-state card">
          <div class="empty-icon">🛍️</div>
          <h3>Пакетів ще немає</h3>
          <p>Додайте фірмові пакети вище, щоб клієнти могли обирати їх під час замовлення.</p>
        </div>
      `;
      return;
    }

    const esc = MarkerStore.escapeHtml;
    listEl.innerHTML = bags.map((bag) => `
      <div class="card admin-item-row ${bag.inStock === false ? 'item-row-out' : ''}">
        <div class="admin-item-info">
          <div class="admin-item-thumb">
            ${bag.image
              ? `<img src="${esc(bag.image)}" alt="${esc(bag.name)}">`
              : `<span>${esc(bag.emoji || '🛍️')}</span>`}
          </div>
          <div>
            <div class="admin-item-title">
              ${bag.code ? `<span class="code-1c-badge">Код: ${esc(bag.code)}</span>` : '<span class="code-1c-badge badge-muted">Без коду</span>'}
              <strong>${esc(bag.name)}</strong>
            </div>
            <div class="admin-item-meta">
              Місткість: <strong>${esc(bag.capacity || 'стандарт')}</strong>
            </div>
          </div>
        </div>

        <div class="admin-item-controls">
          <strong class="admin-item-price">${MarkerStore.formatMoney(bag.price)} грн</strong>

          <button
            type="button"
            class="btn btn-xs btn-secondary"
            data-prod-action="edit-code"
            data-id="${esc(bag.id)}"
          >Код 1С</button>

          <button
            type="button"
            class="btn btn-xs btn-secondary"
            data-prod-action="edit-capacity"
            data-id="${esc(bag.id)}"
          >Місткість</button>

          <button
            type="button"
            class="btn btn-xs btn-secondary"
            data-prod-action="edit-price"
            data-id="${esc(bag.id)}"
          >Ціна</button>

          <button
            type="button"
            class="btn btn-xs ${bag.inStock !== false ? 'btn-success' : 'btn-warning'}"
            data-prod-action="toggle-stock"
            data-id="${esc(bag.id)}"
          >${bag.inStock !== false ? '✓ В наявності' : '✕ Немає'}</button>

          <button
            type="button"
            class="btn btn-xs btn-danger"
            data-prod-action="delete"
            data-id="${esc(bag.id)}"
          >🗑️</button>
        </div>
      </div>
    `).join('');
  }

  function handleProductOrBagAction(e) {
    const btn = e.target.closest('[data-prod-action]');
    if (!btn) return;

    const action = btn.dataset.prodAction;
    const id = btn.dataset.id;
    const prod = MarkerStore.getProducts().find((p) => p.id === id);
    if (!prod) return;

    if (action === 'edit-code') {
      const next = prompt('Введіть код товару (1С / каса):', prod.code || '');
      if (next === null) return;
      MarkerStore.updateProduct(id, { code: next.trim() });
      renderCurrentTab();
      showToast('Код товару оновлено.');
    } else if (action === 'edit-price') {
      const next = prompt('Введіть нову ціну (грн):', String(prod.price));
      if (next === null) return;
      const num = parseFloat(next.replace(',', '.'));
      if (isNaN(num) || num < 0) {
        alert('Введіть коректну ціну.');
        return;
      }
      MarkerStore.updateProduct(id, { price: Math.round(num * 100) / 100 });
      renderCurrentTab();
      showToast('Ціну оновлено.');
    } else if (action === 'edit-capacity') {
      const next = prompt('Введіть місткість пакета (напр. до 10 кг):', prod.capacity || '');
      if (next === null) return;
      MarkerStore.updateProduct(id, { capacity: next.trim() });
      renderCurrentTab();
      showToast('Місткість пакета оновлено.');
    } else if (action === 'toggle-stock') {
      MarkerStore.updateProduct(id, { inStock: prod.inStock === false });
      renderCurrentTab();
      showToast(prod.inStock === false ? 'Товар повернуто в наявність.' : 'Товар позначено як відсутній.');
    } else if (action === 'delete') {
      if (!confirm(`Видалити «${prod.name}»?`)) return;
      MarkerStore.deleteProduct(id);
      renderCurrentTab();
      showToast('Позицію видалено.');
    }
  }

  // --- ВКЛАДКА 4: КАТЕГОРІЇ ---
  function renderCategoriesTab() {
    const settings = MarkerStore.getSettings();
    const autoHideCb = document.getElementById('autoHideEmptyCatsCheckbox');
    if (autoHideCb) autoHideCb.checked = Boolean(settings.autoHideEmptyCategories);

    const listEl = document.getElementById('adminCategoriesList');
    if (!listEl) return;

    const categories = MarkerStore.getCategories();
    const products = MarkerStore.getProducts();
    const esc = MarkerStore.escapeHtml;

    listEl.innerHTML = categories.map((cat, idx) => {
      const count = products.filter((p) => p.category === cat.name).length;
      const isSystem = MarkerStore.SYSTEM_CATEGORIES.includes(cat.name);

      return `
        <div class="card admin-cat-row ${cat.visible === false ? 'cat-hidden-row' : ''}">
          <div class="cat-info">
            <strong>${esc(cat.name)}</strong>
            <span class="badge-pill">${count} тов.</span>
            ${isSystem ? '<span class="badge-system">Системна</span>' : ''}
            ${cat.visible === false ? '<span class="badge-muted">Прихована</span>' : ''}
          </div>

          <div class="cat-controls">
            <button
              type="button"
              class="btn btn-xs btn-secondary"
              data-cat-action="up"
              data-name="${esc(cat.name)}"
              ${idx === 0 ? 'disabled' : ''}
              title="Вгору"
            >▲</button>

            <button
              type="button"
              class="btn btn-xs btn-secondary"
              data-cat-action="down"
              data-name="${esc(cat.name)}"
              ${idx === categories.length - 1 ? 'disabled' : ''}
              title="Вниз"
            >▼</button>

            <button
              type="button"
              class="btn btn-xs ${cat.visible !== false ? 'btn-outline' : 'btn-warning'}"
              data-cat-action="toggle-visible"
              data-name="${esc(cat.name)}"
            >${cat.visible !== false ? '👁️ Видима' : '🙈 Прихована'}</button>

            ${!isSystem ? `
              <button
                type="button"
                class="btn btn-xs btn-danger"
                data-cat-action="delete"
                data-name="${esc(cat.name)}"
              >Видалити</button>
            ` : ''}
          </div>
        </div>
      `;
    }).join('');
  }

  // --- ВКЛАДКА 5: КЛІЄНТИ ТА ЗВІТИ ---
  function renderReportsTab() {
    const tbody = document.getElementById('customerAnalyticsTableBody');
    if (!tbody) return;

    const search = (document.getElementById('customerAnalyticsSearch')?.value || '').trim().toLowerCase();
    const orders = MarkerStore.getOrders();
    const settings = MarkerStore.getSettings();
    const threshold = Number(settings.loyaltyThreshold) || 3;
    const discountPct = Number(settings.loyaltyDiscount) || 5;

    const customerMap = new Map();

    orders.forEach((ord) => {
      const phoneKey = ord.phoneNormalized || MarkerStore.normalizePhone(ord.customerPhone) || ord.customerPhone;
      if (!phoneKey) return;

      if (!customerMap.has(phoneKey)) {
        customerMap.set(phoneKey, {
          name: ord.customerName || 'Без імені',
          phone: ord.customerPhone || phoneKey,
          phoneNormalized: phoneKey,
          totalOrders: 0,
          successfulOrders: 0,
          rejectedOrders: 0,
          successfulRevenue: 0
        });
      }

      const rec = customerMap.get(phoneKey);
      if (ord.customerName) rec.name = ord.customerName;
      rec.totalOrders += 1;

      if (ord.status === 'Відхилено') {
        rec.rejectedOrders += 1;
      } else {
        rec.successfulOrders += 1;
        rec.successfulRevenue += Number(ord.total) || 0;
      }
    });

    let customers = Array.from(customerMap.values()).sort(
      (a, b) => b.successfulRevenue - a.successfulRevenue
    );

    if (search) {
      customers = customers.filter(
        (c) =>
          c.name.toLowerCase().includes(search) ||
          c.phone.toLowerCase().includes(search) ||
          c.phoneNormalized.includes(search)
      );
    }

    if (customers.length === 0) {
      tbody.innerHTML = '<tr><td colspan="8" class="text-center text-muted">Даних про клієнтів ще немає.</td></tr>';
      return;
    }

    const esc = MarkerStore.escapeHtml;
    tbody.innerHTML = customers.map((c) => {
      const successRate = c.totalOrders > 0 ? Math.round((c.successfulOrders / c.totalOrders) * 100) : 0;
      const avgCheck = c.successfulOrders > 0 ? c.successfulRevenue / c.successfulOrders : 0;
      const isLoyal = c.successfulOrders >= threshold;

      return `
        <tr>
          <td><strong>${esc(c.name)}</strong></td>
          <td><a href="tel:${esc(c.phone)}">${esc(c.phone)}</a></td>
          <td>
            ${isLoyal
              ? `<span class="badge-loyal">⭐ Постійний (-${discountPct}%)</span>`
              : `<span class="badge-muted">${c.successfulOrders} / ${threshold}</span>`}
          </td>
          <td>${c.totalOrders}</td>
          <td><span class="text-success">${c.successfulOrders}</span> / <span class="text-danger">${c.rejectedOrders}</span></td>
          <td>
            <div class="success-bar-wrap">
              <div class="success-bar-track">
                <div class="success-bar-fill" style="width: ${successRate}%"></div>
              </div>
              <span>${successRate}%</span>
            </div>
          </td>
          <td><strong>${MarkerStore.formatMoney(c.successfulRevenue)} грн</strong></td>
          <td>${MarkerStore.formatMoney(avgCheck)} грн</td>
        </tr>
      `;
    }).join('');
  }

  function exportExcelCsv(periodType) {
    const allOrders = MarkerStore.getOrders();
    const now = new Date();
    let filtered = [];
    let label = '';

    if (periodType === 'today') {
      const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
      filtered = allOrders.filter((o) => (o.timestamp || 0) >= startOfDay);
      label = 'За сьогодні';
    } else if (periodType === 'month') {
      const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
      filtered = allOrders.filter((o) => (o.timestamp || 0) >= startOfMonth);
      label = 'За цей місяць';
    } else if (periodType === 'range') {
      const fromStr = document.getElementById('exportDateFrom').value;
      const toStr = document.getElementById('exportDateTo').value;
      if (!fromStr || !toStr) {
        alert('Оберіть обидві дати діапазону (Від та До).');
        return;
      }
      const fromTs = new Date(fromStr + 'T00:00:00').getTime();
      const toTs = new Date(toStr + 'T23:59:59').getTime();
      filtered = allOrders.filter((o) => (o.timestamp || 0) >= fromTs && (o.timestamp || 0) <= toTs);
      label = `${fromStr} — ${toStr}`;
    } else {
      filtered = [...allOrders];
      label = 'За весь час';
    }

    const successfulOrders = filtered.filter((o) => o.status !== 'Відхилено');
    const totalRevenue = successfulOrders.reduce((s, o) => s + (Number(o.total) || 0), 0);
    const avgCheck = successfulOrders.length > 0 ? totalRevenue / successfulOrders.length : 0;

    // Підрахунок популярних товарів
    const productStats = new Map();
    successfulOrders.forEach((ord) => {
      (ord.items || []).forEach((it) => {
        if (it.status === 'missing') return;
        const eff = it.status === 'replaced' && it.replacement ? it.replacement : it;
        const key = `${eff.code || ''}||${eff.name}||${eff.unit}`;
        if (!productStats.has(key)) {
          productStats.set(key, {
            code: eff.code || '-',
            name: eff.name,
            unit: eff.unit || 'шт',
            qty: 0,
            revenue: 0
          });
        }
        const stat = productStats.get(key);
        const q = Number(eff.qty) || 0;
        const sum = (Number(eff.price) || 0) * q;
        stat.qty += q;
        stat.revenue += sum;
      });
    });

    const topProducts = Array.from(productStats.values()).sort((a, b) => b.revenue - a.revenue);

    const csvEscape = (val) => {
      const str = String(val ?? '').replace(/"/g, '""');
      return `"${str}"`;
    };
    const fmtNum = (n) => Number(n || 0).toFixed(2).replace('.', ',');

    const rows = [];
    rows.push(['ЗВІТ МАГАЗИНУ MARKET DUO', label]);
    rows.push(['Дата формування', MarkerStore.formatDateTime(Date.now())]);
    rows.push([]);
    rows.push(['ЗВЕДЕНІ ПОКАЗНИКИ']);
    rows.push(['Зведена виручка (грн)', fmtNum(totalRevenue)]);
    rows.push(['Кількість успішних замовлень', successfulOrders.length]);
    rows.push(['Середній чек (грн)', fmtNum(avgCheck)]);
    rows.push([]);
    rows.push(['НАЙПОПУЛЯРНІШІ ТОВАРИ ЗА ПЕРІОД']);
    rows.push(['Код 1С', 'Назва товару', 'Одиниця', 'Продано кількість', 'Виручка (грн)']);

    topProducts.forEach((p) => {
      rows.push([
        p.code,
        p.name,
        p.unit,
        String(Math.round(p.qty * 1000) / 1000).replace('.', ','),
        fmtNum(p.revenue)
      ]);
    });

    rows.push([]);
    rows.push(['ДЕТАЛЬНИЙ РЕЄСТР ЗАМОВЛЕНЬ']);
    rows.push([
      'Код замовлення',
      'Дата і час',
      'Статус',
      'Клієнт',
      'Телефон',
      'Оплата',
      'Свій пакет',
      'Знижка %',
      'Сума до сплати (грн)',
      'Склад замовлення'
    ]);

    filtered.forEach((ord) => {
      const itemsText = (ord.items || [])
        .filter((it) => it.status !== 'missing')
        .map((it) => {
          const eff = it.status === 'replaced' && it.replacement ? it.replacement : it;
          return `${eff.name} (${eff.qty} ${eff.unit})`;
        })
        .join(', ');

      rows.push([
        ord.code,
        MarkerStore.formatDateTime(ord.timestamp),
        ord.status,
        ord.customerName,
        ord.customerPhone,
        ord.paymentMethod === 'card' ? 'Картка' : 'При отриманні',
        ord.ownBag ? 'Так' : 'Ні',
        ord.discountPercent || 0,
        fmtNum(ord.total),
        itemsText
      ]);
    });

    const csvContent = '\uFEFF' + rows.map((r) => r.map(csvEscape).join(';')).join('\r\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);

    const link = document.createElement('a');
    const dateStamp = new Date().toISOString().slice(0, 10);
    link.href = url;
    link.download = `MARKET_DUO_Zvit_${dateStamp}.csv`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);

    showToast('Звіт Excel (.csv) сформовано та завантажено!', 'success');
  }

  // --- ВКЛАДКА 6: НАЛАШТУВАННЯ ---
  function renderSettingsTab() {
    const s = MarkerStore.getSettings();
    document.getElementById('settingsFirebaseUrlInput').value = s.firebaseUrl || '';
    document.getElementById('settingsCardNumberInput').value = s.cardNumber || '';
    document.getElementById('settingsCardRecipientInput').value = s.cardRecipient || '';
    document.getElementById('settingsLoyaltyThresholdInput').value = s.loyaltyThreshold ?? 3;
    document.getElementById('settingsLoyaltyDiscountInput').value = s.loyaltyDiscount ?? 5;
    updateSyncIndicator();
  }

  // --- Ініціалізація обробників подій ---
  function bindDashboardEvents() {
    if (dashboardInitialized) return;
    dashboardInitialized = true;

    // Вкладки
    document.querySelectorAll('.admin-tab').forEach((btn) => {
      btn.addEventListener('click', () => switchAdminTab(btn.dataset.adminTab));
    });

    // Замовлення: оновлення, пошук, фільтр, делегування кліків
    document.getElementById('refreshOrdersBtn').addEventListener('click', async () => {
      await MarkerStore.syncFromCloud();
      checkForNewOrders(MarkerStore.getOrders());
      renderCurrentTab();
      showToast('Дані синхронізовано.');
    });

    document.getElementById('orderSearchInput').addEventListener('input', renderOrdersTab);
    document.getElementById('orderStatusFilter').addEventListener('change', renderOrdersTab);

    const ordersList = document.getElementById('adminOrdersList');
    ordersList.addEventListener('click', handleOrdersListClick);
    ordersList.addEventListener('change', handleOrdersListChange);

    // Модальне вікно відсутнього товару / заміни
    document.getElementById('closeMissingModalBtn').addEventListener('click', closeMissingItemModal);
    document.getElementById('confirmRemoveItemBtn').addEventListener('click', () => applyMissingOrReplacement(null));
    document.getElementById('replacementSearchInput').addEventListener('input', renderReplacementCandidates);
    document.getElementById('replacementCandidatesList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-select-replacement-id]');
      if (!btn) return;
      const prodId = btn.dataset.selectReplacementId;
      const prod = MarkerStore.getProducts().find((p) => p.id === prodId);
      if (prod) applyMissingOrReplacement(prod);
    });

    // Товари: стиснення фото та додавання
    document.getElementById('prodImageFileInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      pendingProdImageBase64 = await MarkerStore.compressImageFile(file, 360, 0.75);
      const preview = document.getElementById('prodImagePreview');
      preview.src = pendingProdImageBase64;
      preview.classList.remove('hidden');
    });

    document.getElementById('addProductForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = document.getElementById('prodCodeInput').value.trim();
      const name = document.getElementById('prodNameInput').value.trim();
      const category = document.getElementById('prodCategoryInput').value.trim() || 'Загальне';
      const unit = document.getElementById('prodUnitInput').value.trim() || '1 шт';
      const price = parseFloat(document.getElementById('prodPriceInput').value) || 0;
      const emoji = document.getElementById('prodEmojiInput').value.trim() || '📦';
      const capacity = document.getElementById('prodCapacityInput').value.trim();
      const imageUrl = document.getElementById('prodImageUrlInput').value.trim();

      if (!name) return;

      MarkerStore.addProduct({
        code,
        name,
        category,
        unit,
        price: Math.round(price * 100) / 100,
        emoji,
        capacity,
        image: pendingProdImageBase64 || imageUrl || '',
        inStock: true,
        isBag: category === MarkerStore.BAGS_CATEGORY
      });

      e.target.reset();
      document.getElementById('prodUnitInput').value = '1 шт';
      document.getElementById('prodEmojiInput').value = '📦';
      pendingProdImageBase64 = '';
      document.getElementById('prodImagePreview').classList.add('hidden');

      renderProductsTab();
      renderKPIs();
      showToast(`Товар «${name}» додано до каталогу!`, 'success');
    });

    document.getElementById('adminProductSearchInput').addEventListener('input', renderProductsTab);
    document.getElementById('adminProductCategoryFilter').addEventListener('change', renderProductsTab);
    document.getElementById('adminProductsList').addEventListener('click', handleProductOrBagAction);

    // Пакети: стиснення фото та додавання
    document.getElementById('bagImageFileInput').addEventListener('change', async (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      pendingBagImageBase64 = await MarkerStore.compressImageFile(file, 360, 0.75);
      const preview = document.getElementById('bagImagePreview');
      preview.src = pendingBagImageBase64;
      preview.classList.remove('hidden');
    });

    document.getElementById('addBagForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const code = document.getElementById('bagCodeInput').value.trim();
      const name = document.getElementById('bagNameInput').value.trim();
      const capacity = document.getElementById('bagCapacityInput').value.trim();
      const price = parseFloat(document.getElementById('bagPriceInput').value) || 0;
      const imageUrl = document.getElementById('bagImageUrlInput').value.trim();

      if (!name) return;

      MarkerStore.addProduct({
        code,
        name,
        category: MarkerStore.BAGS_CATEGORY,
        unit: '1 шт',
        price: Math.round(price * 100) / 100,
        emoji: '🛍️',
        capacity,
        image: pendingBagImageBase64 || imageUrl || '',
        inStock: true,
        isBag: true
      });

      e.target.reset();
      pendingBagImageBase64 = '';
      document.getElementById('bagImagePreview').classList.add('hidden');

      renderBagsTab();
      renderKPIs();
      showToast(`Пакет «${name}» додано!`, 'success');
    });

    document.getElementById('adminBagsList').addEventListener('click', handleProductOrBagAction);

    // Категорії
    document.getElementById('addCategoryForm').addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('newCategoryNameInput');
      const name = input.value.trim();
      if (!name) return;
      MarkerStore.addCategory(name);
      input.value = '';
      renderCategoriesTab();
      showToast(`Категорію «${name}» створено.`);
    });

    document.getElementById('autoHideEmptyCatsCheckbox').addEventListener('change', (e) => {
      MarkerStore.updateSettings({ autoHideEmptyCategories: e.target.checked });
      showToast('Налаштування видимості порожніх категорій збережено.');
    });

    document.getElementById('adminCategoriesList').addEventListener('click', (e) => {
      const btn = e.target.closest('[data-cat-action]');
      if (!btn) return;
      const action = btn.dataset.catAction;
      const name = btn.dataset.name;

      if (action === 'up') {
        MarkerStore.moveCategory(name, 'up');
      } else if (action === 'down') {
        MarkerStore.moveCategory(name, 'down');
      } else if (action === 'toggle-visible') {
        MarkerStore.toggleCategoryVisibility(name);
      } else if (action === 'delete') {
        const res = MarkerStore.deleteCategory(name);
        if (!res.ok) {
          alert(res.error || 'Неможливо видалити категорію.');
          return;
        }
        showToast(`Категорію «${name}» видалено.`);
      }
      renderCategoriesTab();
    });

    // Звіти та клієнти
    document.getElementById('exportTodayBtn').addEventListener('click', () => exportExcelCsv('today'));
    document.getElementById('exportMonthBtn').addEventListener('click', () => exportExcelCsv('month'));
    document.getElementById('exportAllBtn').addEventListener('click', () => exportExcelCsv('all'));
    document.getElementById('exportRangeBtn').addEventListener('click', () => exportExcelCsv('range'));
    document.getElementById('customerAnalyticsSearch').addEventListener('input', renderReportsTab);

    // Налаштування
    document.getElementById('saveFirebaseUrlBtn').addEventListener('click', async () => {
      const url = document.getElementById('settingsFirebaseUrlInput').value.trim().replace(/\/+$/, '');
      MarkerStore.updateSettings({ firebaseUrl: url });
      if (url) {
        await MarkerStore.syncFromCloud();
      }
      updateSyncIndicator();
      showToast('URL бази Firebase збережено!', 'success');
    });

    document.getElementById('pushToCloudBtn').addEventListener('click', async () => {
      const ok = await MarkerStore.pushAllToCloud();
      updateSyncIndicator();
      if (ok) showToast('Усі локальні дані успішно вивантажено у хмару!', 'success');
      else alert('Не вдалося вивантажити дані. Перевірте URL Firebase та правила доступу.');
    });

    document.getElementById('pullFromCloudBtn').addEventListener('click', async () => {
      const ok = await MarkerStore.syncFromCloud();
      renderCurrentTab();
      if (ok) showToast('Дані успішно завантажено з хмари!', 'success');
      else alert('Не вдалося завантажити дані з хмари.');
    });

    document.getElementById('savePaymentSettingsBtn').addEventListener('click', () => {
      const cardNumber = document.getElementById('settingsCardNumberInput').value.trim();
      const cardRecipient = document.getElementById('settingsCardRecipientInput').value.trim();
      MarkerStore.updateSettings({ cardNumber, cardRecipient });
      showToast('Реквізити оплати збережено!', 'success');
    });

    document.getElementById('saveLoyaltySettingsBtn').addEventListener('click', () => {
      const loyaltyThreshold = Math.max(1, parseInt(document.getElementById('settingsLoyaltyThresholdInput').value, 10) || 3);
      const loyaltyDiscount = Math.max(0, Math.min(100, parseFloat(document.getElementById('settingsLoyaltyDiscountInput').value) || 0));
      MarkerStore.updateSettings({ loyaltyThreshold, loyaltyDiscount });
      showToast('Умови програми лояльності збережено!', 'success');
    });

    document.getElementById('saveAdminPasswordBtn').addEventListener('click', () => {
      const pass1 = document.getElementById('settingsNewPasswordInput').value.trim();
      const pass2 = document.getElementById('settingsConfirmPasswordInput').value.trim();
      if (!pass1) {
        alert('Введіть новий пароль.');
        return;
      }
      if (pass1 !== pass2) {
        alert('Паролі не співпадають!');
        return;
      }
      MarkerStore.updateSettings({ adminPassword: pass1 });
      document.getElementById('settingsNewPasswordInput').value = '';
      document.getElementById('settingsConfirmPasswordInput').value = '';
      showToast('Пароль адміністратора успішно змінено!', 'success');
    });

    window.addEventListener('markerstore:updated', () => {
      updateSyncIndicator();
    });
  }

  async function startDashboard() {
    bindDashboardEvents();
    renderCurrentTab();

    await MarkerStore.syncFromCloud();
    checkForNewOrders(MarkerStore.getOrders());
    renderCurrentTab();

    if (autoSyncTimer) clearInterval(autoSyncTimer);
    autoSyncTimer = setInterval(async () => {
      if (!isAuthenticated()) return;
      const synced = await MarkerStore.syncFromCloud();
      if (synced) {
        checkForNewOrders(MarkerStore.getOrders());
        renderKPIs();
        if (activeAdminTab === 'orders') {
          renderOrdersTab();
        }
      }
    }, 3000);
  }

  document.addEventListener('DOMContentLoaded', () => {
    checkFileProtocol();
    MarkerStore.init();
    initAuth();
  });
})();
