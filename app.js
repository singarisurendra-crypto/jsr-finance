/**
 * JSR Instalment Receiving - Core Application Logic
 * Zero-installation, fully client-side persistent finance management system.
 */

const STORAGE_KEYS = {
  SETTINGS: 'jsr_finance_settings',
  SCHEMES: 'jsr_finance_schemes',
  CUSTOMERS: 'jsr_finance_customers',
  TRANSACTIONS: 'jsr_finance_transactions',
};

// Default Initial State
const DEFAULT_SETTINGS = {
  businessName: 'JSR Finance',
  phone: '+91 9876543210',
  address: 'Main Market, City Center',
  currency: '₹',
  defaultGivenAmount: 10000,
  defaultInstalments: 52,
  defaultInstalmentAmount: 200,
  autoCustNumbering: true,
  nextCustNumber: 1,
};

const DEFAULT_SCHEMES = [
  {
    id: 'SCH-52W-STD',
    name: '52 Weeks Standard (₹10,000 / ₹200 wk)',
    totalInstalments: 52,
    frequency: 'Weekly',
    givenAmount: 10000,
    instalmentAmount: 200,
    totalPayable: 10400,
    description: 'Standard 52 weekly instalments of ₹200 for ₹10,000 loan',
    isDefault: true,
  },
  {
    id: 'SCH-52W-20K',
    name: '52 Weeks High Value (₹20,000 / ₹400 wk)',
    totalInstalments: 52,
    frequency: 'Weekly',
    givenAmount: 20000,
    instalmentAmount: 400,
    totalPayable: 20800,
    description: '52 weekly instalments of ₹400 for ₹20,000 loan',
    isDefault: false,
  },
  {
    id: 'SCH-100D-DLY',
    name: '100 Days Daily (₹10,000 / ₹100 day)',
    totalInstalments: 100,
    frequency: 'Daily',
    givenAmount: 10000,
    instalmentAmount: 100,
    totalPayable: 10000,
    description: 'Daily collection plan for 100 days',
    isDefault: false,
  },
];

// App State
let state = {
  settings: { ...DEFAULT_SETTINGS },
  schemes: [...DEFAULT_SCHEMES],
  customers: [],
  activeTab: 'summary',
  searchQuery: '',
  filterStatus: 'all',
};

// Initialize App
function initApp() {
  loadData();
  setupEventListeners();
  updateHeaderStats();
  switchTab('summary');
  if (typeof initGoogleCloudDatabase === 'function') {
    initGoogleCloudDatabase();
  }
}

// Data Storage Management
function loadData() {
  try {
    const savedSettings = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (savedSettings) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) };

    const savedSchemes = localStorage.getItem(STORAGE_KEYS.SCHEMES);
    if (savedSchemes) state.schemes = JSON.parse(savedSchemes);

    const savedCustomers = localStorage.getItem(STORAGE_KEYS.CUSTOMERS);
    if (savedCustomers) {
      state.customers = JSON.parse(savedCustomers);
    } else {
      // Auto-load starter demo data if first time
      loadSampleDemoData(false);
    }
  } catch (err) {
    console.error('Error loading data from localStorage', err);
  }
}

function saveDataLocallyOnly() {
  try {
    localStorage.setItem(STORAGE_KEYS.SETTINGS, JSON.stringify(state.settings));
    localStorage.setItem(STORAGE_KEYS.SCHEMES, JSON.stringify(state.schemes));
    localStorage.setItem(STORAGE_KEYS.CUSTOMERS, JSON.stringify(state.customers));
    updateHeaderStats();
  } catch (err) {
    console.error('Error saving data to localStorage', err);
  }
}

function saveData() {
  saveDataLocallyOnly();
  if (typeof syncSettingsToFirestore === 'function') {
    syncSettingsToFirestore(state.settings);
  }
}

// Format Currency
function formatMoney(amount) {
  const num = Number(amount) || 0;
  return `${state.settings.currency} ${num.toLocaleString('en-IN')}`;
}

// Helper: Calculate Customer Stats
function getCustomerStats(customer) {
  const totalInst = customer.totalInstalments || 52;
  const instalments = customer.instalments || [];
  let paidCount = 0;
  let totalPaid = 0;

  for (let i = 0; i < totalInst; i++) {
    const inst = instalments[i];
    if (inst && inst.status === 'Received') {
      paidCount++;
      totalPaid += (inst.paidAmount || customer.instalmentAmount);
    }
  }

  const pendingCount = totalInst - paidCount;
  const totalPayable = customer.totalPayable || (customer.instalmentAmount * totalInst);
  const balance = Math.max(0, totalPayable - totalPaid);
  const progressPercent = Math.min(100, Math.round((paidCount / totalInst) * 100));

  return {
    paidCount,
    pendingCount,
    totalPaid,
    balance,
    progressPercent,
    isCompleted: paidCount >= totalInst,
  };
}

// Helper: Global Portfolio Metrics
function getPortfolioStats() {
  let totalDisbursed = 0;
  let totalCollected = 0;
  let totalPayable = 0;
  let totalBalance = 0;
  let activeLoans = 0;
  let completedLoans = 0;
  let todayCollected = 0;

  const todayStr = new Date().toISOString().split('T')[0];

  state.customers.forEach((cust) => {
    totalDisbursed += (cust.givenAmount || 0);
    const stats = getCustomerStats(cust);
    totalCollected += stats.totalPaid;
    totalBalance += stats.balance;
    totalPayable += (cust.totalPayable || 0);

    if (stats.isCompleted) {
      completedLoans++;
    } else {
      activeLoans++;
    }

    // Check today's collections
    if (cust.instalments) {
      cust.instalments.forEach((inst) => {
        if (inst && inst.status === 'Received' && inst.paidDate === todayStr) {
          todayCollected += (inst.paidAmount || cust.instalmentAmount);
        }
      });
    }
  });

  const recoveryPercent = totalPayable > 0 ? Math.round((totalCollected / totalPayable) * 100) : 0;

  return {
    totalCustomers: state.customers.length,
    activeLoans,
    completedLoans,
    totalDisbursed,
    totalCollected,
    totalBalance,
    todayCollected,
    recoveryPercent,
  };
}

// Update Persistent Header Stats
function updateHeaderStats() {
  const stats = getPortfolioStats();
  document.getElementById('header-active-cust').textContent = stats.activeLoans;
  document.getElementById('header-disbursed').textContent = formatMoney(stats.totalDisbursed);
  document.getElementById('header-collected').textContent = formatMoney(stats.totalCollected);
  document.getElementById('header-today').textContent = formatMoney(stats.todayCollected);

  // Set business name in header and brand
  document.getElementById('brand-business-name').textContent = state.settings.businessName || 'JSR Finance';
}

// Navigation & Tab Switching
function switchTab(tabName) {
  state.activeTab = tabName;

  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.tab === tabName);
  });

  document.querySelectorAll('.screen-view').forEach((view) => {
    view.classList.toggle('active', view.id === `view-${tabName}`);
  });

  if (tabName === 'summary') renderDashboard();
  if (tabName === 'collections') renderCollectionMatrix();
  if (tabName === 'customers') renderCustomersTable();
  if (tabName === 'schemes') renderSchemesTable();
  if (tabName === 'settings') renderSettings();
}

// ----------------------------------------------------
// SCREEN 1: SUMMARY SCREEN (DASHBOARD)
// ----------------------------------------------------
function renderDashboard() {
  const stats = getPortfolioStats();

  document.getElementById('kpi-disbursed').textContent = formatMoney(stats.totalDisbursed);
  document.getElementById('kpi-disbursed-sub').textContent = `${stats.totalCustomers} Total Loans Disbursed`;

  document.getElementById('kpi-collected').textContent = formatMoney(stats.totalCollected);
  document.getElementById('kpi-collected-sub').textContent = `${stats.recoveryPercent}% Recovered to Date`;

  document.getElementById('kpi-balance').textContent = formatMoney(stats.totalBalance);
  document.getElementById('kpi-balance-sub').textContent = `${stats.activeLoans} Active Loans Remaining`;

  document.getElementById('kpi-today').textContent = formatMoney(stats.todayCollected);

  // Recovery Progress Bar
  const progFill = document.getElementById('dashboard-progress-fill');
  progFill.style.width = `${stats.recoveryPercent}%`;
  document.getElementById('dashboard-progress-label').textContent = `${stats.recoveryPercent}% Complete (${formatMoney(stats.totalCollected)} of ${formatMoney(stats.totalDisbursed)})`;

  // Milestone distribution counts
  let w1to10 = 0, w11to25 = 0, w26to40 = 0, w41to52 = 0;
  state.customers.forEach((c) => {
    const s = getCustomerStats(c);
    if (s.paidCount <= 10) w1to10++;
    else if (s.paidCount <= 25) w11to25++;
    else if (s.paidCount <= 40) w26to40++;
    else w41to52++;
  });

  document.getElementById('dist-w1-10').textContent = `${w1to10} Cust`;
  document.getElementById('dist-w11-25').textContent = `${w11to25} Cust`;
  document.getElementById('dist-w26-40').textContent = `${w26to40} Cust`;
  document.getElementById('dist-w41-52').textContent = `${w41to52} Cust`;

  // Recent Collections Feed
  const recentList = document.getElementById('recent-transactions-list');
  const allPaid = [];
  state.customers.forEach((c) => {
    (c.instalments || []).forEach((inst) => {
      if (inst && inst.status === 'Received') {
        allPaid.push({
          customerNumber: c.customerNumber,
          customerName: c.fullName,
          instNumber: inst.number,
          paidDate: inst.paidDate || 'Today',
          amount: inst.paidAmount || c.instalmentAmount,
          receiptNumber: inst.receiptNumber || `REC-${inst.number}`,
        });
      }
    });
  });

  // Sort descending by paidDate/receipt
  allPaid.sort((a, b) => (b.paidDate || '').localeCompare(a.paidDate || '')).slice(0, 8);

  if (allPaid.length === 0) {
    recentList.innerHTML = `<tr><td colspan="5" style="text-align:center; padding:20px; color:#94a3b8;">No collections recorded yet.</td></tr>`;
  } else {
    recentList.innerHTML = allPaid.map((item) => `
      <tr>
        <td><strong>#${item.customerNumber}</strong> - ${item.customerName}</td>
        <td>Instalment #${item.instNumber}</td>
        <td><span style="color:#16a34a; font-weight:600;">+ ${formatMoney(item.amount)}</span></td>
        <td>${item.paidDate}</td>
        <td><span class="badge-received" style="width:auto; padding:2px 8px;">Received</span></td>
      </tr>
    `).join('');
  }
}

// ----------------------------------------------------
// SCREEN 2: 52-INSTALMENT COLLECTION SHEET (MATRIX GRID)
// ----------------------------------------------------
function renderCollectionMatrix() {
  const tableHead = document.getElementById('matrix-table-head');
  const tableBody = document.getElementById('matrix-table-body');
  const maxInst = 52; // standard 52 instalments

  // Generate Header Row
  let headHtml = `
    <tr>
      <th class="sticky-col-1">Cust #</th>
      <th class="sticky-col-2">Customer Name</th>
      <th class="sticky-col-3">Given / Inst</th>
      <th style="min-width: 90px;">Paid / Bal</th>
  `;

  for (let w = 1; w <= maxInst; w++) {
    headHtml += `<th class="inst-col" style="min-width: 44px;">Wk ${w}</th>`;
  }
  headHtml += `</tr>`;
  tableHead.innerHTML = headHtml;

  // Filter Customers
  const query = state.searchQuery.toLowerCase().trim();
  const filtered = state.customers.filter((c) => {
    const matchesSearch =
      c.customerNumber.toString().toLowerCase().includes(query) ||
      c.fullName.toLowerCase().includes(query) ||
      (c.phone && c.phone.includes(query)) ||
      (c.areaRoute && c.areaRoute.toLowerCase().includes(query));

    const stats = getCustomerStats(c);
    if (!matchesSearch) return false;
    if (state.filterStatus === 'active') return !stats.isCompleted;
    if (state.filterStatus === 'completed') return stats.isCompleted;
    return true;
  });

  if (filtered.length === 0) {
    tableBody.innerHTML = `<tr><td colspan="${maxInst + 4}" style="text-align:center; padding:40px; color:#94a3b8;">No customers match the current search or filter.</td></tr>`;
    return;
  }

  // Generate Body Rows
  let bodyHtml = '';
  filtered.forEach((cust) => {
    const stats = getCustomerStats(cust);
    const instCount = cust.totalInstalments || 52;

    bodyHtml += `
      <tr data-customer-id="${cust.id}">
        <td class="sticky-col-1">
          <span style="font-weight:700; color:#1e3a8a;">#${cust.customerNumber}</span>
        </td>
        <td class="sticky-col-2">
          <div style="font-weight:600;">${cust.fullName}</div>
          <div style="font-size:11px; color:#64748b;">${cust.phone || 'No Phone'}</div>
        </td>
        <td class="sticky-col-3">
          <div style="font-weight:600; color:#0f172a;">${formatMoney(cust.givenAmount)}</div>
          <div style="font-size:11px; color:#2563eb;">${formatMoney(cust.instalmentAmount)} /wk</div>
        </td>
        <td>
          <div style="font-weight:600;">${stats.paidCount}/${instCount}</div>
          <div style="font-size:11px; color:#b45309;">Bal: ${formatMoney(stats.balance)}</div>
        </td>
    `;

    for (let w = 1; w <= maxInst; w++) {
      if (w > instCount) {
        bodyHtml += `<td style="background:#f1f5f9; color:#cbd5e1;">-</td>`;
        continue;
      }

      const inst = (cust.instalments && cust.instalments[w - 1]) || { number: w, status: 'Pending' };
      const isReceived = inst.status === 'Received';

      bodyHtml += `
        <td class="inst-cell" 
            onclick="toggleInstalmentReceived('${cust.id}', ${w})" 
            title="Customer #${cust.customerNumber} - Week ${w}: ${isReceived ? 'Received on ' + (inst.paidDate || 'Today') : 'Click to mark Received'}">
          ${
            isReceived
              ? `<span class="badge-received">✓</span>`
              : `<span class="badge-pending">${w}</span>`
          }
        </td>
      `;
    }

    bodyHtml += `</tr>`;
  });

  tableBody.innerHTML = bodyHtml;
}

// 1-Click Toggle Instalment
function toggleInstalmentReceived(customerId, instNumber) {
  const customer = state.customers.find((c) => c.id === customerId);
  if (!customer) return;

  if (!customer.instalments) {
    customer.instalments = [];
    for (let i = 1; i <= (customer.totalInstalments || 52); i++) {
      customer.instalments.push({ number: i, status: 'Pending' });
    }
  }

  // Ensure all indices up to instNumber exist
  while (customer.instalments.length < instNumber) {
    customer.instalments.push({ number: customer.instalments.length + 1, status: 'Pending' });
  }

  const inst = customer.instalments[instNumber - 1];
  const todayStr = new Date().toISOString().split('T')[0];

  if (inst.status === 'Received') {
    // Undo
    inst.status = 'Pending';
    inst.paidDate = null;
    inst.paidAmount = 0;
  } else {
    // Mark Received
    inst.status = 'Received';
    inst.paidDate = todayStr;
    inst.paidAmount = customer.instalmentAmount;
    inst.receiptNumber = `REC-${customer.customerNumber}-${instNumber}`;
  }

  saveData();
  if (typeof syncCustomerToFirestore === 'function') {
    syncCustomerToFirestore(customer);
  }
  renderCollectionMatrix();
  if (state.activeTab === 'summary') renderDashboard();
}

// Quick Numpad Entry Handler
function handleQuickReceive(event) {
  if (event) event.preventDefault();

  const custNumInput = document.getElementById('quick-cust-num');
  const custNum = custNumInput.value.trim();

  if (!custNum) {
    alert('Please enter a Customer Number');
    return;
  }

  const customer = state.customers.find((c) => c.customerNumber.toString() === custNum);
  if (!customer) {
    alert(`Customer #${custNum} not found.`);
    return;
  }

  // Find next pending instalment
  const totalInst = customer.totalInstalments || 52;
  if (!customer.instalments) customer.instalments = [];

  let nextPending = 0;
  for (let i = 1; i <= totalInst; i++) {
    const inst = customer.instalments[i - 1];
    if (!inst || inst.status !== 'Received') {
      nextPending = i;
      break;
    }
  }

  if (nextPending === 0) {
    alert(`Customer #${custNum} (${customer.fullName}) has already paid all ${totalInst} instalments!`);
    return;
  }

  toggleInstalmentReceived(customer.id, nextPending);

  // Clear or refocus for next rapid entry
  custNumInput.value = '';
  custNumInput.focus();

  // Show brief feedback toast
  showToast(`Received Week #${nextPending} for #${customer.customerNumber} (${customer.fullName})`);
}

// ----------------------------------------------------
// SCREEN 3: CUSTOMER MASTER & PASSBOOK
// ----------------------------------------------------
function renderCustomersTable() {
  const tbody = document.getElementById('customers-table-body');
  const query = state.searchQuery.toLowerCase().trim();

  const filtered = state.customers.filter((c) => {
    return (
      c.customerNumber.toString().toLowerCase().includes(query) ||
      c.fullName.toLowerCase().includes(query) ||
      (c.phone && c.phone.includes(query)) ||
      (c.areaRoute && c.areaRoute.toLowerCase().includes(query))
    );
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="9" style="text-align:center; padding:30px; color:#94a3b8;">No customers registered yet. Click "+ Add New Customer" to start.</td></tr>`;
    return;
  }

  tbody.innerHTML = filtered.map((c) => {
    const stats = getCustomerStats(c);
    const totalInst = c.totalInstalments || 52;
    return `
      <tr>
        <td><strong style="color:#1e3a8a; font-size:14px;">#${c.customerNumber}</strong></td>
        <td>
          <div style="font-weight:600;">${c.fullName}</div>
          <div style="font-size:12px; color:#64748b;">${c.address || 'No Address'}</div>
        </td>
        <td>${c.phone || '-'}</td>
        <td><span style="background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:4px; font-size:11px;">${c.areaRoute || 'General'}</span></td>
        <td><strong>${formatMoney(c.givenAmount)}</strong></td>
        <td>${formatMoney(c.instalmentAmount)} /wk</td>
        <td>
          <div style="font-weight:600;">${stats.paidCount} / ${totalInst} (${stats.progressPercent}%)</div>
          <div class="progress-bar-bg" style="margin-top:4px; width:100px;">
            <div class="progress-bar-fill" style="width:${stats.progressPercent}%;"></div>
          </div>
        </td>
        <td><strong style="color:#b45309;">${formatMoney(stats.balance)}</strong></td>
        <td>
          <div class="btn-group">
            <button class="btn btn-outline btn-sm" onclick="openCustomerPassbook('${c.id}')">📖 Passbook</button>
            <button class="btn btn-outline btn-sm" onclick="openEditCustomerModal('${c.id}')">✏️ Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteCustomer('${c.id}')">🗑️</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');
}

// Open Add Customer Modal
function openAddCustomerModal() {
  document.getElementById('modal-customer-title').textContent = 'Add New Customer';
  document.getElementById('form-customer-id').value = '';

  // Auto assign next number
  let nextNum = state.settings.nextCustNumber || 1;
  const existingNums = new Set(state.customers.map(c => Number(c.customerNumber)));
  while (existingNums.has(nextNum)) {
    nextNum++;
  }

  document.getElementById('cust-form-number').value = nextNum;
  document.getElementById('cust-form-name').value = '';
  document.getElementById('cust-form-phone').value = '';
  document.getElementById('cust-form-address').value = '';
  document.getElementById('cust-form-area').value = 'Main Area';
  document.getElementById('cust-form-given').value = state.settings.defaultGivenAmount || 10000;
  document.getElementById('cust-form-instalments').value = state.settings.defaultInstalments || 52;
  document.getElementById('cust-form-amount').value = state.settings.defaultInstalmentAmount || 200;
  document.getElementById('cust-form-date').value = new Date().toISOString().split('T')[0];

  document.getElementById('modal-customer').classList.add('active');
}

// Open Edit Customer Modal
function openEditCustomerModal(customerId) {
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  document.getElementById('modal-customer-title').textContent = `Edit Customer #${c.customerNumber}`;
  document.getElementById('form-customer-id').value = c.id;
  document.getElementById('cust-form-number').value = c.customerNumber;
  document.getElementById('cust-form-name').value = c.fullName;
  document.getElementById('cust-form-phone').value = c.phone || '';
  document.getElementById('cust-form-address').value = c.address || '';
  document.getElementById('cust-form-area').value = c.areaRoute || '';
  document.getElementById('cust-form-given').value = c.givenAmount;
  document.getElementById('cust-form-instalments').value = c.totalInstalments || 52;
  document.getElementById('cust-form-amount').value = c.instalmentAmount || 200;
  document.getElementById('cust-form-date').value = c.startDate || new Date().toISOString().split('T')[0];

  document.getElementById('modal-customer').classList.add('active');
}

// Save Customer (Create or Update)
function handleSaveCustomer(event) {
  event.preventDefault();

  const id = document.getElementById('form-customer-id').value;
  const customerNumber = document.getElementById('cust-form-number').value.trim();
  const fullName = document.getElementById('cust-form-name').value.trim();
  const phone = document.getElementById('cust-form-phone').value.trim();
  const address = document.getElementById('cust-form-address').value.trim();
  const areaRoute = document.getElementById('cust-form-area').value.trim();
  const givenAmount = Number(document.getElementById('cust-form-given').value) || 10000;
  const totalInstalments = Number(document.getElementById('cust-form-instalments').value) || 52;
  const instalmentAmount = Number(document.getElementById('cust-form-amount').value) || 200;
  const startDate = document.getElementById('cust-form-date').value;

  if (!fullName) {
    alert('Please enter Customer Full Name');
    return;
  }

  // Check duplicate customer number
  const duplicate = state.customers.find((c) => c.customerNumber.toString() === customerNumber && c.id !== id);
  if (duplicate) {
    alert(`Customer number #${customerNumber} is already taken by ${duplicate.fullName}. Please choose a unique number.`);
    return;
  }

  if (id) {
    // Edit existing
    const existing = state.customers.find((c) => c.id === id);
    if (existing) {
      existing.customerNumber = customerNumber;
      existing.fullName = fullName;
      existing.phone = phone;
      existing.address = address;
      existing.areaRoute = areaRoute;
      existing.givenAmount = givenAmount;
      existing.totalInstalments = totalInstalments;
      existing.instalmentAmount = instalmentAmount;
      existing.totalPayable = totalInstalments * instalmentAmount;
      existing.startDate = startDate;
    }
  } else {
    // Create new customer
    const newId = 'CUST-' + Date.now();
    const instalments = [];
    for (let i = 1; i <= totalInstalments; i++) {
      instalments.push({
        number: i,
        dueAmount: instalmentAmount,
        paidAmount: 0,
        status: 'Pending',
      });
    }

    state.customers.push({
      id: newId,
      customerNumber,
      fullName,
      phone,
      address,
      areaRoute,
      givenAmount,
      totalInstalments,
      instalmentAmount,
      totalPayable: totalInstalments * instalmentAmount,
      startDate,
      status: 'Active',
      instalments,
      createdAt: new Date().toISOString(),
    });

    state.settings.nextCustNumber = Number(customerNumber) + 1;
  }

  saveData();
  const savedCust = state.customers.find((c) => c.customerNumber.toString() === customerNumber);
  if (savedCust && typeof syncCustomerToFirestore === 'function') {
    syncCustomerToFirestore(savedCust);
  }
  closeModal('modal-customer');
  renderCustomersTable();
  renderCollectionMatrix();
  renderDashboard();
  showToast(`Customer #${customerNumber} saved successfully!`);
}

// Delete Customer
function deleteCustomer(customerId) {
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  if (confirm(`Are you sure you want to delete Customer #${c.customerNumber} (${c.fullName})? All 52-week records for this customer will be removed.`)) {
    state.customers = state.customers.filter((cust) => cust.id !== customerId);
    saveData();
    if (typeof deleteCustomerFromFirestore === 'function') {
      deleteCustomerFromFirestore(customerId);
    }
    renderCustomersTable();
    renderCollectionMatrix();
    renderDashboard();
    showToast(`Customer #${c.customerNumber} deleted.`);
  }
}

// ----------------------------------------------------
// CUSTOMER PASSBOOK / LEDGER MODAL
// ----------------------------------------------------
function openCustomerPassbook(customerId) {
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  const stats = getCustomerStats(c);
  const totalInst = c.totalInstalments || 52;

  document.getElementById('passbook-modal-title').textContent = `Customer Passbook - #${c.customerNumber}: ${c.fullName}`;
  document.getElementById('passbook-header-info').innerHTML = `
    <div style="display:grid; grid-template-columns: repeat(4, 1fr); gap:12px; background:#f1f5f9; padding:14px; border-radius:8px; margin-bottom:16px;">
      <div><span style="color:#64748b; font-size:12px;">Customer:</span><br><strong>#${c.customerNumber} - ${c.fullName}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Phone:</span><br><strong>${c.phone || 'N/A'}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Given Amount:</span><br><strong style="color:#1e3a8a;">${formatMoney(c.givenAmount)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Instalment:</span><br><strong>${formatMoney(c.instalmentAmount)} /wk</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Total Paid:</span><br><strong style="color:#16a34a;">${formatMoney(stats.totalPaid)} (${stats.paidCount}/${totalInst})</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Balance Due:</span><br><strong style="color:#b45309;">${formatMoney(stats.balance)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Start Date:</span><br><strong>${c.startDate || 'N/A'}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Status:</span><br><span class="badge-received" style="width:auto; padding:2px 8px;">${stats.isCompleted ? 'Completed' : 'Active'}</span></div>
    </div>
  `;

  // Render 52 rows
  const tbody = document.getElementById('passbook-table-body');
  let rowsHtml = '';
  for (let w = 1; w <= totalInst; w++) {
    const inst = (c.instalments && c.instalments[w - 1]) || { number: w, status: 'Pending' };
    const isReceived = inst.status === 'Received';

    rowsHtml += `
      <tr>
        <td><strong>Week #${w}</strong></td>
        <td>${formatMoney(c.instalmentAmount)}</td>
        <td>
          ${isReceived ? `<span class="badge-received" style="width:auto; padding:2px 8px;">✓ Received</span>` : `<span style="color:#94a3b8;">Pending</span>`}
        </td>
        <td>${inst.paidDate || '-'}</td>
        <td>${inst.receiptNumber || '-'}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="toggleInstalmentReceived('${c.id}', ${w}); openCustomerPassbook('${c.id}');">
            ${isReceived ? 'Undo' : 'Mark Received'}
          </button>
        </td>
      </tr>
    `;
  }
  tbody.innerHTML = rowsHtml;

  // Setup WhatsApp share button
  const shareBtn = document.getElementById('passbook-whatsapp-btn');
  const msg = encodeURIComponent(
    `*${state.settings.businessName}*\nCustomer: #${c.customerNumber} - ${c.fullName}\nGiven Amount: ${formatMoney(c.givenAmount)}\nInstalments Paid: ${stats.paidCount}/${totalInst}\nTotal Paid: ${formatMoney(stats.totalPaid)}\nBalance Remaining: ${formatMoney(stats.balance)}\nThank you!`
  );
  shareBtn.onclick = () => window.open(`https://wa.me/${c.phone ? c.phone.replace(/[^0-9]/g, '') : ''}?text=${msg}`, '_blank');

  document.getElementById('modal-passbook').classList.add('active');
}

// ----------------------------------------------------
// SCREEN 4: SCHEMES & INSTALMENTS MASTER
// ----------------------------------------------------
function renderSchemesTable() {
  const tbody = document.getElementById('schemes-table-body');
  tbody.innerHTML = state.schemes.map((s) => `
    <tr>
      <td><strong>${s.id}</strong></td>
      <td><strong>${s.name}</strong><br><span style="font-size:11px; color:#64748b;">${s.description || ''}</span></td>
      <td>${s.totalInstalments} Instalments</td>
      <td><span class="badge-received" style="width:auto; padding:2px 8px; background:#e0e7ff; color:#3730a3;">${s.frequency}</span></td>
      <td><strong>${formatMoney(s.givenAmount)}</strong></td>
      <td><strong>${formatMoney(s.instalmentAmount)}</strong></td>
      <td><strong>${formatMoney(s.totalPayable)}</strong></td>
      <td>
        ${s.isDefault ? `<span style="color:#16a34a; font-weight:600;">Default</span>` : `<button class="btn btn-outline btn-sm" onclick="setDefaultScheme('${s.id}')">Set Default</button>`}
      </td>
    </tr>
  `).join('');
}

function setDefaultScheme(schemeId) {
  state.schemes.forEach((s) => {
    s.isDefault = s.id === schemeId;
    if (s.isDefault) {
      state.settings.defaultInstalments = s.totalInstalments;
      state.settings.defaultGivenAmount = s.givenAmount;
      state.settings.defaultInstalmentAmount = s.instalmentAmount;
    }
  });
  saveData();
  renderSchemesTable();
  showToast(`Default scheme updated!`);
}

// ----------------------------------------------------
// SCREEN 5: SETTINGS
// ----------------------------------------------------
function renderSettings() {
  document.getElementById('setting-business-name').value = state.settings.businessName;
  document.getElementById('setting-phone').value = state.settings.phone;
  document.getElementById('setting-address').value = state.settings.address;
  document.getElementById('setting-currency').value = state.settings.currency;
  document.getElementById('setting-default-given').value = state.settings.defaultGivenAmount;
  document.getElementById('setting-default-instalments').value = state.settings.defaultInstalments;
  document.getElementById('setting-default-inst-amount').value = state.settings.defaultInstalmentAmount;
}

function handleSaveSettings(event) {
  event.preventDefault();

  state.settings.businessName = document.getElementById('setting-business-name').value.trim() || 'JSR Finance';
  state.settings.phone = document.getElementById('setting-phone').value.trim();
  state.settings.address = document.getElementById('setting-address').value.trim();
  state.settings.currency = document.getElementById('setting-currency').value.trim() || '₹';
  state.settings.defaultGivenAmount = Number(document.getElementById('setting-default-given').value) || 10000;
  state.settings.defaultInstalments = Number(document.getElementById('setting-default-instalments').value) || 52;
  state.settings.defaultInstalmentAmount = Number(document.getElementById('setting-default-inst-amount').value) || 200;

  saveData();
  updateHeaderStats();
  showToast('Settings saved successfully!');
}

// Export Data as JSON Backup
function exportDataBackup() {
  const exportObject = {
    exportDate: new Date().toISOString(),
    version: '1.0',
    settings: state.settings,
    schemes: state.schemes,
    customers: state.customers,
  };

  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportObject, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', dataStr);
  downloadAnchor.setAttribute('download', `JSR_Finance_Backup_${new Date().toISOString().split('T')[0]}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

// Import JSON Backup
function importDataBackup(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function (e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (imported.customers && imported.settings) {
        state.settings = imported.settings;
        state.customers = imported.customers;
        if (imported.schemes) state.schemes = imported.schemes;
        saveData();
        initApp();
        alert('Data backup successfully restored!');
      } else {
        alert('Invalid backup file format.');
      }
    } catch (err) {
      alert('Error parsing backup JSON file.');
    }
  };
  reader.readAsText(file);
}

// Export Collection Sheet as CSV
function exportCollectionSheetCSV() {
  let csv = 'Cust Number,Customer Name,Phone,Given Amount,Instalment Amount,Paid Count,Balance';
  for (let i = 1; i <= 52; i++) csv += `,Week ${i}`;
  csv += '\n';

  state.customers.forEach((c) => {
    const s = getCustomerStats(c);
    let row = `"${c.customerNumber}","${c.fullName}","${c.phone || ''}",${c.givenAmount},${c.instalmentAmount},${s.paidCount},${s.balance}`;
    for (let i = 1; i <= 52; i++) {
      const inst = (c.instalments && c.instalments[i - 1]) || {};
      row += `,"${inst.status === 'Received' ? 'Received' : 'Pending'}"`;
    }
    csv += row + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `JSR_Instalment_Sheet_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
}

// Load Realistic Sample Demo Data
function loadSampleDemoData(confirmPrompt = true) {
  if (confirmPrompt && !confirm('Load sample demonstration data? (This will add 5 sample customers with 52-week collection records)')) {
    return;
  }

  const sampleCustomers = [
    {
      id: 'DEMO-1',
      customerNumber: '1',
      fullName: 'Ramesh Kumar',
      phone: '9876543210',
      address: 'Shop #12, Market Complex',
      areaRoute: 'Market Line',
      givenAmount: 10000,
      totalInstalments: 52,
      instalmentAmount: 200,
      totalPayable: 10400,
      startDate: '2026-06-01',
      status: 'Active',
      instalments: Array.from({ length: 52 }, (_, i) => ({
        number: i + 1,
        dueAmount: 200,
        paidAmount: i < 18 ? 200 : 0,
        paidDate: i < 18 ? '2026-09-15' : null,
        status: i < 18 ? 'Received' : 'Pending',
        receiptNumber: i < 18 ? `REC-1-${i + 1}` : null,
      })),
    },
    {
      id: 'DEMO-2',
      customerNumber: '2',
      fullName: 'Priya Sharma',
      phone: '9812345678',
      address: 'Flat 4A, Gandhi Nagar',
      areaRoute: 'North Bazaar',
      givenAmount: 10000,
      totalInstalments: 52,
      instalmentAmount: 200,
      totalPayable: 10400,
      startDate: '2026-07-10',
      status: 'Active',
      instalments: Array.from({ length: 52 }, (_, i) => ({
        number: i + 1,
        dueAmount: 200,
        paidAmount: i < 12 ? 200 : 0,
        paidDate: i < 12 ? '2026-09-20' : null,
        status: i < 12 ? 'Received' : 'Pending',
        receiptNumber: i < 12 ? `REC-2-${i + 1}` : null,
      })),
    },
    {
      id: 'DEMO-3',
      customerNumber: '3',
      fullName: 'Vijay Anand',
      phone: '9822334455',
      address: 'Plot 88, Station Road',
      areaRoute: 'Station Road',
      givenAmount: 20000,
      totalInstalments: 52,
      instalmentAmount: 400,
      totalPayable: 20800,
      startDate: '2026-05-15',
      status: 'Active',
      instalments: Array.from({ length: 52 }, (_, i) => ({
        number: i + 1,
        dueAmount: 400,
        paidAmount: i < 22 ? 400 : 0,
        paidDate: i < 22 ? '2026-09-28' : null,
        status: i < 22 ? 'Received' : 'Pending',
        receiptNumber: i < 22 ? `REC-3-${i + 1}` : null,
      })),
    },
    {
      id: 'DEMO-4',
      customerNumber: '4',
      fullName: 'Deepa Patel',
      phone: '9833445566',
      address: '23/B, Cross Street',
      areaRoute: 'Market Line',
      givenAmount: 10000,
      totalInstalments: 52,
      instalmentAmount: 200,
      totalPayable: 10400,
      startDate: '2026-08-01',
      status: 'Active',
      instalments: Array.from({ length: 52 }, (_, i) => ({
        number: i + 1,
        dueAmount: 200,
        paidAmount: i < 8 ? 200 : 0,
        paidDate: i < 8 ? '2026-09-30' : null,
        status: i < 8 ? 'Received' : 'Pending',
        receiptNumber: i < 8 ? `REC-4-${i + 1}` : null,
      })),
    },
    {
      id: 'DEMO-5',
      customerNumber: '5',
      fullName: 'Mohan Lal',
      phone: '9844556677',
      address: '54 Old Subzi Mandi',
      areaRoute: 'North Bazaar',
      givenAmount: 10000,
      totalInstalments: 52,
      instalmentAmount: 200,
      totalPayable: 10400,
      startDate: '2026-04-01',
      status: 'Completed',
      instalments: Array.from({ length: 52 }, (_, i) => ({
        number: i + 1,
        dueAmount: 200,
        paidAmount: 200,
        paidDate: '2026-10-01',
        status: 'Received',
        receiptNumber: `REC-5-${i + 1}`,
      })),
    },
  ];

  state.customers = sampleCustomers;
  state.settings.nextCustNumber = 6;
  saveData();
  initApp();
  if (confirmPrompt) showToast('Sample demo data loaded successfully!');
}

function clearAllData() {
  if (confirm('CAUTION: Are you sure you want to reset all data? This will clear all customers and instalments.')) {
    state.customers = [];
    state.settings.nextCustNumber = 1;
    saveData();
    initApp();
    showToast('All customer data cleared.');
  }
}

// UI Helpers: Modals & Toasts
function closeModal(modalId) {
  document.getElementById(modalId).classList.remove('active');
}

function showToast(message) {
  const toast = document.getElementById('app-toast');
  if (!toast) return;
  toast.textContent = message;
  toast.style.display = 'block';
  setTimeout(() => {
    toast.style.display = 'none';
  }, 2600);
}

// Event Listeners Setup
function setupEventListeners() {
  // Navigation tabs
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(link.dataset.tab);
    });
  });

  // Global search input
  const searchInput = document.getElementById('global-search-input');
  if (searchInput) {
    searchInput.addEventListener('input', (e) => {
      state.searchQuery = e.target.value;
      if (state.activeTab === 'collections') renderCollectionMatrix();
      if (state.activeTab === 'customers') renderCustomersTable();
    });
  }

  // Filter selector
  const filterSelect = document.getElementById('collection-filter-select');
  if (filterSelect) {
    filterSelect.addEventListener('change', (e) => {
      state.filterStatus = e.target.value;
      renderCollectionMatrix();
    });
  }
}

// Start application when DOM is ready
window.addEventListener('DOMContentLoaded', initApp);
