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
    // One-time cleanup: Wipe old demo data from browser localStorage for live production
    if (localStorage.getItem('jsr_demo_cleaned_v2') !== 'true') {
      localStorage.removeItem(STORAGE_KEYS.CUSTOMERS);
      localStorage.setItem('jsr_demo_cleaned_v2', 'true');
    }

    const savedSettings = localStorage.getItem(STORAGE_KEYS.SETTINGS);
    if (savedSettings) state.settings = { ...DEFAULT_SETTINGS, ...JSON.parse(savedSettings) };

    const savedSchemes = localStorage.getItem(STORAGE_KEYS.SCHEMES);
    if (savedSchemes) state.schemes = JSON.parse(savedSchemes);

    const savedCustomers = localStorage.getItem(STORAGE_KEYS.CUSTOMERS);
    if (savedCustomers) {
      try {
        const parsed = JSON.parse(savedCustomers);
        // Automatically filter out any starter demo data for live production use
        state.customers = Array.isArray(parsed) ? parsed.filter(c => c && c.id && !c.id.startsWith('DEMO-')) : [];
      } catch (e) {
        state.customers = [];
      }
    } else {
      state.customers = [];
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

  // Profit calculations
  const given = Number(customer.givenAmount) || 0;
  const expectedProfit = Math.max(0, totalPayable - given);
  const profitMarginRate = totalPayable > 0 ? (expectedProfit / totalPayable) : 0;
  const profitReturnPercent = given > 0 ? Math.round((expectedProfit / given) * 1000) / 10 : 0;
  const realizedProfit = Math.round(totalPaid * profitMarginRate);

  return {
    paidCount,
    pendingCount,
    totalPaid,
    totalPayable,
    balance,
    progressPercent,
    expectedProfit,
    realizedProfit,
    profitReturnPercent,
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
  let totalExpectedProfit = 0;
  let totalRealizedProfit = 0;

  const todayStr = new Date().toISOString().split('T')[0];

  state.customers.forEach((cust) => {
    totalDisbursed += (cust.givenAmount || 0);
    const stats = getCustomerStats(cust);
    totalCollected += stats.totalPaid;
    totalBalance += stats.balance;
    totalPayable += (cust.totalPayable || 0);
    totalExpectedProfit += stats.expectedProfit;
    totalRealizedProfit += stats.realizedProfit;

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
  const todayProfit = todayCollected > 0 && totalPayable > 0 ? Math.round(todayCollected * (totalExpectedProfit / totalPayable)) : 0;

  return {
    totalCustomers: state.customers.length,
    activeLoans,
    completedLoans,
    totalDisbursed,
    totalCollected,
    totalBalance,
    totalPayable,
    todayCollected,
    totalExpectedProfit,
    totalRealizedProfit,
    todayProfit,
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

  const headerProfit = document.getElementById('header-profit');
  if (headerProfit) {
    headerProfit.textContent = formatMoney(stats.totalRealizedProfit);
    headerProfit.title = `Earned Profit: ${formatMoney(stats.totalRealizedProfit)} | Expected Total Profit: ${formatMoney(stats.totalExpectedProfit)}`;
  }

  // Set business name in header and brand
  document.getElementById('brand-business-name').textContent = state.settings.businessName || 'JSR Finance';
}

// Navigation & Tab Switching
function switchTab(tabName) {
  state.activeTab = tabName;

  document.querySelectorAll('.nav-link').forEach((link) => {
    link.classList.toggle('active', link.dataset.tab === tabName);
  });

  document.querySelectorAll('.mobile-nav-item').forEach((item) => {
    item.classList.toggle('active', item.dataset.tab === tabName);
  });

  document.querySelectorAll('.screen-view').forEach((view) => {
    view.classList.toggle('active', view.id === `view-${tabName}`);
  });

  const sidebar = document.getElementById('app-sidebar');
  if (sidebar) {
    sidebar.classList.add('force-collapsed');
  }

  window.scrollTo({ top: 0, behavior: 'smooth' });

  if (tabName === 'summary') renderDashboard();
  if (tabName === 'collections') renderCollectionMatrix();
  if (tabName === 'customers') renderCustomersTable();
  if (tabName === 'analytics') renderAnalytics();
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

  const kpiProfit = document.getElementById('kpi-profit');
  if (kpiProfit) {
    kpiProfit.textContent = formatMoney(stats.totalRealizedProfit);
    document.getElementById('kpi-profit-sub').textContent = `Total Expected: ${formatMoney(stats.totalExpectedProfit)}`;
  }

  // Recovery Progress Bar
  const progFill = document.getElementById('dashboard-progress-fill');
  if (progFill) progFill.style.width = `${stats.recoveryPercent}%`;
  const progLabel = document.getElementById('dashboard-progress-label');
  if (progLabel) progLabel.textContent = `${stats.recoveryPercent}% Complete (${formatMoney(stats.totalCollected)} of ${formatMoney(stats.totalDisbursed)})`;

  // Milestone distribution counts
  let w1to10 = 0, w11to25 = 0, w26to40 = 0, w41to52 = 0;
  state.customers.forEach((c) => {
    const s = getCustomerStats(c);
    if (s.paidCount <= 10) w1to10++;
    else if (s.paidCount <= 25) w11to25++;
    else if (s.paidCount <= 40) w26to40++;
    else w41to52++;
  });

  const dist1 = document.getElementById('dist-w1-10');
  const dist2 = document.getElementById('dist-w11-25');
  const dist3 = document.getElementById('dist-w26-40');
  const dist4 = document.getElementById('dist-w41-52');
  if (dist1) dist1.textContent = `${w1to10} Cust`;
  if (dist2) dist2.textContent = `${w11to25} Cust`;
  if (dist3) dist3.textContent = `${w26to40} Cust`;
  if (dist4) dist4.textContent = `${w41to52} Cust`;

  // Render filtered recent transactions feed
  renderRecentTransactions();
}

// Recent Collections Feed with Interactive Filtering
function renderRecentTransactions() {
  const recentList = document.getElementById('recent-transactions-list');
  if (!recentList) return;

  const dateFilter = document.getElementById('recent-date-filter')?.value || 'all';
  const searchQuery = (document.getElementById('recent-search-filter')?.value || '').toLowerCase().trim();
  const routeFilter = document.getElementById('recent-route-filter')?.value || 'all';

  // Populate routes dropdown if empty
  const routeSelect = document.getElementById('recent-route-filter');
  if (routeSelect && routeSelect.options.length <= 1) {
    const uniqueRoutes = Array.from(new Set(state.customers.map(c => c.areaRoute).filter(Boolean)));
    uniqueRoutes.forEach(route => {
      const opt = document.createElement('option');
      opt.value = route;
      opt.textContent = `📍 ${route}`;
      routeSelect.appendChild(opt);
    });
  }

  // Get current date benchmarks
  const now = new Date();
  const todayStr = now.toISOString().split('T')[0];
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const yesterdayStr = yesterday.toISOString().split('T')[0];
  
  const weekAgo = new Date(now);
  weekAgo.setDate(now.getDate() - 7);
  const weekAgoStr = weekAgo.toISOString().split('T')[0];

  const monthStartStr = new Date(now.getFullYear(), now.getMonth(), 1).toISOString().split('T')[0];

  let allPaid = [];
  state.customers.forEach((c) => {
    (c.instalments || []).forEach((inst) => {
      if (inst && inst.status === 'Received') {
        allPaid.push({
          customerId: c.id,
          customerNumber: c.customerNumber,
          loanNumber: c.loanNumber || 1,
          customerName: c.fullName,
          areaRoute: c.areaRoute || 'General',
          instNumber: inst.number,
          paidDate: inst.paidDate || todayStr,
          amount: inst.paidAmount || c.instalmentAmount,
          receiptNumber: inst.receiptNumber || `REC-${inst.number}`,
        });
      }
    });
  });

  // Apply filters
  const filtered = allPaid.filter(item => {
    // Date filter
    const itemDate = item.paidDate;
    if (dateFilter === 'today' && itemDate !== todayStr && itemDate !== 'Today') return false;
    if (dateFilter === 'yesterday' && itemDate !== yesterdayStr) return false;
    if (dateFilter === 'this-week' && itemDate < weekAgoStr) return false;
    if (dateFilter === 'this-month' && itemDate < monthStartStr) return false;

    // Search filter
    if (searchQuery) {
      const matchNum = item.customerNumber.toString().includes(searchQuery);
      const matchName = item.customerName.toLowerCase().includes(searchQuery);
      if (!matchNum && !matchName) return false;
    }

    // Route filter
    if (routeFilter !== 'all' && item.areaRoute !== routeFilter) return false;

    return true;
  });

  // Sort descending by paidDate/receipt
  filtered.sort((a, b) => (b.paidDate || '').localeCompare(a.paidDate || ''));

  // Update Summary count
  const countEl = document.getElementById('recent-summary-count');
  const totalAmount = filtered.reduce((sum, item) => sum + item.amount, 0);
  if (countEl) {
    countEl.textContent = `Showing ${filtered.length} collections · Total: ${formatMoney(totalAmount)}`;
  }

  if (filtered.length === 0) {
    recentList.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:24px; color:#94a3b8;">No collections match the selected filters.</td></tr>`;
  } else {
    recentList.innerHTML = filtered.slice(0, 50).map((item) => `
      <tr>
        <td>
          <strong>#${item.customerNumber}</strong>${item.loanNumber > 1 ? ` <span class="loan-badge">L${item.loanNumber}</span>` : ''} - ${item.customerName}
        </td>
        <td>Instalment #${item.instNumber}</td>
        <td><span style="color:#16a34a; font-weight:700;">+ ${formatMoney(item.amount)}</span></td>
        <td>${item.paidDate}</td>
        <td><span style="background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:4px; font-size:11px;">${item.areaRoute}</span></td>
        <td><span class="badge-received" style="width:auto; padding:2px 8px;">Received</span></td>
      </tr>
    `).join('');
  }
}

// ----------------------------------------------------
// ANALYTICS & INSIGHTS ENGINE
// ----------------------------------------------------
function renderAnalytics() {
  const customers = state.customers || [];
  
  let totalDisbursed = 0;
  let totalPayable = 0;
  let totalCollected = 0;
  let totalExpectedProfit = 0;
  let totalRealizedProfit = 0;
  let activeLoansCount = 0;
  let completedLoansCount = 0;
  let totalDueWeeks = 0;
  let totalPaidWeeks = 0;
  let nextWeekProjected = 0;

  const routeMap = {};
  const weekCollectionMap = {};
  for (let w = 1; w <= 52; w++) {
    weekCollectionMap[w] = 0;
  }

  customers.forEach(c => {
    const stats = getCustomerStats(c);
    totalDisbursed += (c.givenAmount || 0);
    totalPayable += (stats.totalPayable || 0);
    totalCollected += (stats.totalPaid || 0);
    totalExpectedProfit += (stats.expectedProfit || 0);
    totalRealizedProfit += (stats.realizedProfit || 0);

    if (stats.isCompleted) {
      completedLoansCount++;
    } else {
      activeLoansCount++;
      nextWeekProjected += (c.instalmentAmount || 0);
    }

    const instCount = c.totalInstalments || 52;
    totalDueWeeks += instCount;
    totalPaidWeeks += stats.paidCount;

    // Route map
    const route = c.areaRoute || 'General';
    if (!routeMap[route]) {
      routeMap[route] = { route, count: 0, disbursed: 0, collected: 0 };
    }
    routeMap[route].count++;
    routeMap[route].disbursed += (c.givenAmount || 0);
    routeMap[route].collected += (stats.totalPaid || 0);

    // Week collections map
    (c.instalments || []).forEach(inst => {
      if (inst && inst.status === 'Received') {
        const w = inst.number;
        if (w >= 1 && w <= 52) {
          weekCollectionMap[w] += (inst.paidAmount || c.instalmentAmount || 0);
        }
      }
    });
  });

  // Rates
  const principalRecovered = Math.min(totalDisbursed, totalCollected);
  const recoveryRate = totalDisbursed > 0 ? Math.round((principalRecovered / totalDisbursed) * 100) : 0;
  const profitYield = totalDisbursed > 0 ? ((totalRealizedProfit / totalDisbursed) * 100).toFixed(1) : '0.0';
  const collectionVelocity = totalDueWeeks > 0 ? Math.round((totalPaidWeeks / totalDueWeeks) * 100) : 0;
  const remainingOutlay = Math.max(0, totalDisbursed - principalRecovered);

  // Set Top KPI cards
  const elRate = document.getElementById('ana-recovery-rate');
  const elRateSub = document.getElementById('ana-recovery-sub');
  if (elRate) elRate.textContent = `${recoveryRate}%`;
  if (elRateSub) elRateSub.textContent = `${formatMoney(principalRecovered)} of ${formatMoney(totalDisbursed)}`;

  const elYield = document.getElementById('ana-profit-yield');
  const elYieldSub = document.getElementById('ana-profit-sub');
  if (elYield) elYield.textContent = `${profitYield}%`;
  if (elYieldSub) elYieldSub.textContent = `+ ${formatMoney(totalRealizedProfit)} Earned`;

  const elVel = document.getElementById('ana-collection-rate');
  const elVelSub = document.getElementById('ana-velocity-sub');
  if (elVel) elVel.textContent = `${collectionVelocity}%`;
  if (elVelSub) elVelSub.textContent = `${totalPaidWeeks} of ${totalDueWeeks} Weeks`;

  const elProj = document.getElementById('ana-projected-week');
  if (elProj) elProj.textContent = formatMoney(nextWeekProjected);

  // Meter Bar
  const meterPct = totalPayable > 0 ? Math.round((totalCollected / totalPayable) * 100) : 0;
  const elMeterPct = document.getElementById('ana-meter-pct');
  if (elMeterPct) elMeterPct.textContent = `${meterPct}%`;

  const prinPct = totalPayable > 0 ? Math.round((principalRecovered / totalPayable) * 100) : 0;
  const profPct = totalPayable > 0 ? Math.round((totalRealizedProfit / totalPayable) * 100) : 0;

  const barPrin = document.getElementById('ana-bar-principal');
  const barProf = document.getElementById('ana-bar-profit');
  if (barPrin) barPrin.style.width = `${prinPct}%`;
  if (barProf) barProf.style.width = `${profPct}%`;

  const elPrinRec = document.getElementById('ana-stat-prin-rec');
  const elProfRec = document.getElementById('ana-stat-prof-rec');
  const elRem = document.getElementById('ana-stat-remaining');
  if (elPrinRec) elPrinRec.textContent = formatMoney(principalRecovered);
  if (elProfRec) elProfRec.textContent = formatMoney(totalRealizedProfit);
  if (elRem) elRem.textContent = formatMoney(remainingOutlay);

  // Weekly Collection Bar Chart (SVG / HTML Flex bars)
  const chartEl = document.getElementById('ana-weekly-chart');
  if (chartEl) {
    let maxVal = 1;
    for (let w = 1; w <= 16; w++) {
      if (weekCollectionMap[w] > maxVal) maxVal = weekCollectionMap[w];
    }
    let chartHtml = '';
    for (let w = 1; w <= 16; w++) {
      const val = weekCollectionMap[w] || 0;
      const heightPct = Math.max(8, Math.round((val / maxVal) * 100));
      chartHtml += `
        <div style="flex:1; display:flex; flex-direction:column; align-items:center; gap:4px; height:100%; justify-content:flex-end;">
          <div style="font-size:10px; font-weight:700; color:#2563eb;">${val > 0 ? (val >= 1000 ? (val/1000).toFixed(0)+'k' : val) : ''}</div>
          <div style="width:100%; max-width:24px; height:${heightPct}%; background:${val > 0 ? 'linear-gradient(180deg, #3b82f6 0%, #2563eb 100%)' : '#e2e8f0'}; border-radius:4px 4px 0 0;" title="Week ${w}: ${formatMoney(val)}"></div>
          <div style="font-size:10px; color:#64748b; font-weight:600;">W${w}</div>
        </div>
      `;
    }
    chartEl.innerHTML = chartHtml;
  }

  // Route breakdown table
  const routesTbody = document.getElementById('ana-routes-table-body');
  if (routesTbody) {
    const routeList = Object.values(routeMap);
    if (routeList.length === 0) {
      routesTbody.innerHTML = '<tr><td colspan="5" style="text-align:center; padding:16px; color:#94a3b8;">No route data yet.</td></tr>';
    } else {
      routesTbody.innerHTML = routeList.map(r => {
        const recPct = r.disbursed > 0 ? Math.round((r.collected / r.disbursed) * 100) : 0;
        return `
          <tr>
            <td><strong>${r.route}</strong></td>
            <td>${r.count}</td>
            <td>${formatMoney(r.disbursed)}</td>
            <td><strong style="color:#16a34a;">${formatMoney(r.collected)}</strong></td>
            <td><span style="font-weight:700; color:#2563eb;">${recPct}%</span></td>
          </tr>
        `;
      }).join('');
    }
  }

  // Health Radar list
  const healthListEl = document.getElementById('ana-health-list');
  if (healthListEl) {
    healthListEl.innerHTML = `
      <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#f0fdf4; border:1px solid #bbf7d0; border-radius:8px;">
        <div>
          <strong style="color:#15803d; font-size:13px;">✓ Completed Loans (100% Repaid)</strong>
          <div style="font-size:11px; color:#166534;">Fully recovered principal & maximum profit collected</div>
        </div>
        <span style="font-size:18px; font-weight:800; color:#15803d;">${completedLoansCount}</span>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px;">
        <div>
          <strong style="color:#1d4ed8; font-size:13px;">⚡ Active Generating Loans</strong>
          <div style="font-size:11px; color:#1e40af;">Currently paying weekly instalments as scheduled</div>
        </div>
        <span style="font-size:18px; font-weight:800; color:#1d4ed8;">${activeLoansCount}</span>
      </div>
      <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; background:#fffbeb; border:1px solid #fde68a; border-radius:8px;">
        <div>
          <strong style="color:#b45309; font-size:13px;">💰 Outstanding Total Balance</strong>
          <div style="font-size:11px; color:#92400e;">Remaining collections to be gathered across active loans</div>
        </div>
        <span style="font-size:18px; font-weight:800; color:#b45309;">${formatMoney(totalPayable - totalCollected)}</span>
      </div>
    `;
  }
}

// ----------------------------------------------------
// SCREEN 2: INSTALMENT COLLECTION SHEET (MATRIX GRID)
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
          ${(cust.loanNumber && cust.loanNumber > 1) || state.customers.filter(c => c.customerNumber.toString() === cust.customerNumber.toString()).length > 1
            ? ` <span class="loan-badge">L${cust.loanNumber || 1}</span>`
            : ''}
        </td>
        <td class="sticky-col-2">
          <div style="font-weight:600; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:140px;" title="${cust.fullName}">${cust.fullName}</div>
          <div style="font-size:11px; color:#64748b; text-overflow:ellipsis; overflow:hidden; white-space:nowrap; max-width:140px;">${cust.phone || 'No Phone'}</div>
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
            title="Customer #${cust.customerNumber}${cust.loanNumber > 1 ? ` (Loan ${cust.loanNumber})` : ''} - Week ${w}: ${isReceived ? 'Received on ' + (inst.paidDate || 'Today') : 'Click to mark Received'}">
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
  const rawInput = custNumInput.value.trim();

  if (!rawInput) {
    alert('Please enter a Customer Number (e.g. 1, or 1-2 for Loan 2)');
    return;
  }

  // Parse input for loan format e.g. "1-2", "1L2", "1 l 2", "1/2", "1"
  let targetCustNum = rawInput;
  let targetLoanNum = null;
  const match = rawInput.match(/^(\d+)[\s\-_/lL]+(\d+)$/);
  if (match) {
    targetCustNum = match[1];
    targetLoanNum = parseInt(match[2], 10);
  }

  // Find matching customer(s)
  const matches = state.customers.filter((c) => c.customerNumber.toString() === targetCustNum);
  if (matches.length === 0) {
    alert(`Customer #${targetCustNum} not found.`);
    return;
  }

  let customer = null;
  if (targetLoanNum !== null) {
    customer = matches.find((c) => (Number(c.loanNumber) || 1) === targetLoanNum);
    if (!customer) {
      alert(`Customer #${targetCustNum} does not have Loan #${targetLoanNum}. Available loans: ${matches.map(m => 'L' + (m.loanNumber || 1)).join(', ')}`);
      return;
    }
  } else if (matches.length === 1) {
    customer = matches[0];
  } else {
    // Multiple loans exist for this customer: select first with pending instalment
    const pendingLoans = matches.filter((c) => {
      const stats = getCustomerStats(c);
      return stats.pendingCount > 0;
    });

    if (pendingLoans.length === 0) {
      alert(`All loans for Customer #${targetCustNum} (${matches[0].fullName}) are already completed!`);
      return;
    }

    customer = pendingLoans[0]; // defaults to lowest active loan
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
    alert(`Customer #${customer.customerNumber} Loan #${customer.loanNumber || 1} (${customer.fullName}) has already paid all ${totalInst} instalments!`);
    return;
  }

  toggleInstalmentReceived(customer.id, nextPending);

  // Clear or refocus for next rapid entry
  custNumInput.value = '';
  custNumInput.focus();

  // Show brief feedback toast with multi-loan guidance
  const loanTag = (customer.loanNumber && customer.loanNumber > 1) || matches.length > 1 ? ` L${customer.loanNumber || 1}` : '';
  const multiTip = matches.length > 1 ? ` (Tip: type ${targetCustNum}-2 for Loan 2)` : '';
  showToast(`Received Week #${nextPending} for #${customer.customerNumber}${loanTag} (${customer.fullName})${multiTip}`);
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
    tbody.innerHTML = `<tr><td colspan="11" style="text-align:center; padding:30px; color:#94a3b8;">No customers registered yet. Click "+ Add New Customer" to start.</td></tr>`;
    const mobileContainer = document.getElementById('customers-mobile-cards');
    if (mobileContainer) {
      mobileContainer.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8; background:#fff; border-radius:12px; border:1px solid #e2e8f0;">No customers registered yet.</div>`;
    }
    return;
  }

  tbody.innerHTML = filtered.map((c) => {
    const stats = getCustomerStats(c);
    const totalInst = c.totalInstalments || 52;
    const hasMultipleLoans = (c.loanNumber && c.loanNumber > 1) || state.customers.filter(x => x.customerNumber.toString() === c.customerNumber.toString()).length > 1;
    return `
      <tr>
        <td>
          <strong style="color:#1e3a8a; font-size:14px;">#${c.customerNumber}</strong>
          ${hasMultipleLoans ? ` <span class="loan-badge">L${c.loanNumber || 1}</span>` : ''}
        </td>
        <td>
          <div style="font-weight:600;">${c.fullName}</div>
          <div style="font-size:12px; color:#64748b;">${c.address || 'No Address'}</div>
        </td>
        <td>${c.phone || '-'}</td>
        <td><span style="background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:4px; font-size:11px;">${c.areaRoute || 'General'}</span></td>
        <td><strong>${formatMoney(c.givenAmount)}</strong></td>
        <td>${formatMoney(c.instalmentAmount)} /wk</td>
        <td><strong>${formatMoney(stats.totalPayable)}</strong></td>
        <td>
          <strong style="color: #7c3aed;">+ ${formatMoney(stats.expectedProfit)}</strong>
          <div style="font-size: 11px; color: #16a34a; font-weight: 600;">Earned: ${formatMoney(stats.realizedProfit)}</div>
        </td>
        <td>
          <div style="font-weight:600;">${stats.paidCount} / ${totalInst} (${stats.progressPercent}%)</div>
          <div class="progress-bar-bg" style="margin-top:4px; width:100px;">
            <div class="progress-bar-fill" style="width:${stats.progressPercent}%;"></div>
          </div>
        </td>
        <td><strong style="color:#b45309;">${formatMoney(stats.balance)}</strong></td>
        <td>
          <div class="btn-group">
            <button class="btn btn-outline btn-sm" onclick="openCustomerPassbook('${c.id}')">Passbook</button>
            <button class="btn btn-outline btn-sm" onclick="openAddLoanForCustomer('${c.customerNumber}')" title="Issue additional loan to customer" style="color: #2563eb; font-weight: 600;">+ Loan</button>
            <button class="btn btn-outline btn-sm" onclick="openEditCustomerModal('${c.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteCustomer('${c.id}')" title="Delete">Delete</button>
          </div>
        </td>
      </tr>
    `;
  }).join('');

  // Mobile Customer Touch-Cards Render
  const mobileContainer = document.getElementById('customers-mobile-cards');
  if (mobileContainer) {
    mobileContainer.innerHTML = filtered.map((c) => {
      const stats = getCustomerStats(c);
      const totalInst = c.totalInstalments || 52;
      const hasMultipleLoans = (c.loanNumber && c.loanNumber > 1) || state.customers.filter(x => x.customerNumber.toString() === c.customerNumber.toString()).length > 1;
      return `
        <div class="customer-card">
          <div class="customer-card-header">
            <div class="customer-card-title">
              <span class="customer-card-num">#${c.customerNumber}</span>
              ${hasMultipleLoans ? `<span class="loan-badge">L${c.loanNumber || 1}</span>` : ''}
              <div>
                <div class="customer-card-name">${c.fullName}</div>
                <div class="customer-card-meta">${c.phone || 'No Phone'} • <span style="background:#e0f2fe; color:#0369a1; padding:1px 6px; border-radius:4px; font-size:11px;">${c.areaRoute || 'General'}</span></div>
              </div>
            </div>
            <span class="badge-received" style="width:auto; padding:3px 10px; font-size:11px;">${stats.isCompleted ? 'Completed' : 'Active'}</span>
          </div>

          <div class="customer-card-grid">
            <div>
              <div class="card-stat-label">Given Amount</div>
              <div class="card-stat-val" style="color:#1e3a8a;">${formatMoney(c.givenAmount)}</div>
            </div>
            <div>
              <div class="card-stat-label">Total Repayable</div>
              <div class="card-stat-val">${formatMoney(stats.totalPayable)}</div>
            </div>
            <div>
              <div class="card-stat-label">Collected (${stats.paidCount}/${totalInst})</div>
              <div class="card-stat-val" style="color:#16a34a;">${formatMoney(stats.totalPaid)}</div>
            </div>
            <div>
              <div class="card-stat-label">Remaining Balance</div>
              <div class="card-stat-val" style="color:#b45309;">${formatMoney(stats.balance)}</div>
            </div>
            <div>
              <div class="card-stat-label">Expected Profit</div>
              <div class="card-stat-val" style="color:#7c3aed;">+ ${formatMoney(stats.expectedProfit)}</div>
            </div>
            <div>
              <div class="card-stat-label">Earned Profit</div>
              <div class="card-stat-val" style="color:#16a34a;">${formatMoney(stats.realizedProfit)}</div>
            </div>
          </div>

          <div style="margin: 8px 0;">
            <div style="display:flex; justify-content:space-between; font-size:11px; margin-bottom:4px;">
              <span style="color:#64748b;">Recovery Progress</span>
              <strong style="color:#2563eb;">${stats.progressPercent}%</strong>
            </div>
            <div class="progress-bar-bg">
              <div class="progress-bar-fill" style="width:${stats.progressPercent}%;"></div>
            </div>
          </div>

          <div class="customer-card-actions">
            <button class="btn btn-outline" onclick="openCustomerPassbook('${c.id}')">Passbook</button>
            <button class="btn btn-outline" onclick="openAddLoanForCustomer('${c.customerNumber}')" style="color: #2563eb; font-weight: 600;">+ Loan</button>
            <button class="btn btn-outline" onclick="openEditCustomerModal('${c.id}')">Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteCustomer('${c.id}')" style="flex:0; padding:8px 12px;">Delete</button>
          </div>
        </div>
      `;
    }).join('');
  }
}

// Dynamic Profit Calculation for Customer Modal
function updateCustomerModalProfitCalc() {
  const given = Number(document.getElementById('cust-form-given')?.value) || 0;
  const instalments = Number(document.getElementById('cust-form-instalments')?.value) || 0;
  const amount = Number(document.getElementById('cust-form-amount')?.value) || 0;

  const repayable = instalments * amount;
  const profit = Math.max(0, repayable - given);
  const profitPct = given > 0 ? (Math.round((profit / given) * 1000) / 10).toFixed(1) : '0.0';

  const repayableEl = document.getElementById('cust-form-calc-repayable');
  const profitEl = document.getElementById('cust-form-calc-profit');
  const profitPctEl = document.getElementById('cust-form-calc-profit-pct');

  if (repayableEl) repayableEl.textContent = formatMoney(repayable);
  if (profitEl) profitEl.textContent = `+ ${formatMoney(profit)}`;
  if (profitPctEl) profitPctEl.textContent = `${profitPct}%`;
}

// Bi-directional Auto Calculation: Margin % -> Instalment Amount
function calculateFromMargin() {
  const given = Number(document.getElementById('cust-form-given')?.value) || 0;
  const marginPct = Number(document.getElementById('cust-form-margin')?.value) || 0;
  const instalments = Number(document.getElementById('cust-form-instalments')?.value) || 52;
  if (given > 0 && instalments > 0) {
    const repayable = Math.round(given * (1 + marginPct / 100));
    const instAmount = Math.round(repayable / instalments);
    const amountInput = document.getElementById('cust-form-amount');
    if (amountInput) amountInput.value = instAmount;
  }
  updateCustomerModalProfitCalc();
}

// Bi-directional Auto Calculation: Instalment Amount -> Margin %
function calculateFromAmount() {
  const given = Number(document.getElementById('cust-form-given')?.value) || 0;
  const instAmount = Number(document.getElementById('cust-form-amount')?.value) || 0;
  const instalments = Number(document.getElementById('cust-form-instalments')?.value) || 52;
  if (given > 0 && instalments > 0 && instAmount > 0) {
    const repayable = instalments * instAmount;
    const profit = repayable - given;
    const marginPct = ((profit / given) * 100).toFixed(1);
    const marginInput = document.getElementById('cust-form-margin');
    if (marginInput) marginInput.value = marginPct;
  }
  updateCustomerModalProfitCalc();
}

function setMarginPreset(pct) {
  const marginInput = document.getElementById('cust-form-margin');
  if (marginInput) {
    marginInput.value = pct;
    calculateFromMargin();
  }
}

function setInstalmentsPreset(count) {
  const instInput = document.getElementById('cust-form-instalments');
  if (instInput) {
    instInput.value = count;
    calculateFromMargin();
  }
}

// Multi-Loan Handling Mode Switcher
function toggleLoanTypeMode(mode) {
  const wrap = document.getElementById('existing-customer-selector-wrap');
  const custNumInput = document.getElementById('cust-form-number');
  const nameInput = document.getElementById('cust-form-name');
  const phoneInput = document.getElementById('cust-form-phone');
  const addressInput = document.getElementById('cust-form-address');
  const areaInput = document.getElementById('cust-form-area');
  const loanNumInput = document.getElementById('cust-form-loan-number');
  const titleEl = document.getElementById('modal-customer-title');

  if (mode === 'existing') {
    if (wrap) wrap.style.display = 'block';
    populateExistingCustomerSelect();
    const select = document.getElementById('cust-form-existing-select');
    if (select && select.value) {
      handleSelectExistingCustomer(select.value);
    }
  } else {
    if (wrap) wrap.style.display = 'none';
    if (titleEl) titleEl.textContent = 'Add New Customer';
    if (loanNumInput) loanNumInput.value = '1';

    if (custNumInput) custNumInput.readOnly = false;
    if (nameInput) nameInput.readOnly = false;
    if (phoneInput) phoneInput.readOnly = false;
    if (addressInput) addressInput.readOnly = false;
    if (areaInput) areaInput.readOnly = false;

    // Suggest next customer number
    let nextNum = state.settings.nextCustNumber || 1;
    const existingNums = new Set(state.customers.map(c => Number(c.customerNumber)));
    while (existingNums.has(nextNum)) {
      nextNum++;
    }
    if (custNumInput && !document.getElementById('form-customer-id').value) {
      custNumInput.value = nextNum;
    }
  }
}

function populateExistingCustomerSelect(selectedCustNum) {
  const select = document.getElementById('cust-form-existing-select');
  if (!select) return;

  const map = new Map();
  state.customers.forEach(c => {
    const num = c.customerNumber.toString();
    if (!map.has(num)) {
      map.set(num, { customerNumber: num, fullName: c.fullName, phone: c.phone, loans: [] });
    }
    map.get(num).loans.push(c);
  });

  const sorted = Array.from(map.values()).sort((a, b) => Number(a.customerNumber) - Number(b.customerNumber));

  if (sorted.length === 0) {
    select.innerHTML = '<option value="">No existing customers found</option>';
    return;
  }

  select.innerHTML = sorted.map(c => `
    <option value="${c.customerNumber}" ${c.customerNumber === (selectedCustNum || '').toString() ? 'selected' : ''}>
      #${c.customerNumber} - ${c.fullName} (${c.loans.length} existing loan${c.loans.length > 1 ? 's' : ''})
    </option>
  `).join('');
}

function handleSelectExistingCustomer(custNum) {
  if (!custNum) return;
  const matching = state.customers.filter(c => c.customerNumber.toString() === custNum.toString());
  if (matching.length === 0) return;

  const base = matching[0];
  const maxLoan = matching.reduce((max, c) => Math.max(max, Number(c.loanNumber) || 1), 1);
  const nextLoan = maxLoan + 1;

  const custNumInput = document.getElementById('cust-form-number');
  const nameInput = document.getElementById('cust-form-name');
  const phoneInput = document.getElementById('cust-form-phone');
  const addressInput = document.getElementById('cust-form-address');
  const areaInput = document.getElementById('cust-form-area');
  const loanNumInput = document.getElementById('cust-form-loan-number');

  if (custNumInput) { custNumInput.value = base.customerNumber; custNumInput.readOnly = true; }
  if (nameInput) { nameInput.value = base.fullName; nameInput.readOnly = true; }
  if (phoneInput) { phoneInput.value = base.phone || ''; }
  if (addressInput) { addressInput.value = base.address || ''; }
  if (areaInput) { areaInput.value = base.areaRoute || ''; }
  if (loanNumInput) { loanNumInput.value = nextLoan; }

  const titleEl = document.getElementById('modal-customer-title');
  if (titleEl) titleEl.textContent = `Issue Loan #${nextLoan} to #${base.customerNumber} (${base.fullName})`;

  const helpEl = document.getElementById('existing-cust-loan-count-help');
  if (helpEl) {
    helpEl.textContent = `Customer already has ${matching.length} loan(s). This creates separate ledger Loan #${nextLoan}.`;
  }
}

function openAddLoanForCustomer(customerNumber) {
  openAddCustomerModal();
  const radioExisting = document.getElementById('loan-type-existing');
  if (radioExisting) {
    radioExisting.checked = true;
    toggleLoanTypeMode('existing');
    populateExistingCustomerSelect(customerNumber);
    const select = document.getElementById('cust-form-existing-select');
    if (select) {
      select.value = customerNumber.toString();
      handleSelectExistingCustomer(customerNumber);
    }
  }
}

// Open Add Customer Modal
function openAddCustomerModal() {
  document.getElementById('modal-customer-title').textContent = 'Add New Customer';
  document.getElementById('form-customer-id').value = '';
  document.getElementById('cust-form-loan-number').value = '1';

  const radioNew = document.getElementById('loan-type-new');
  if (radioNew) radioNew.checked = true;
  toggleLoanTypeMode('new');

  document.getElementById('cust-form-name').value = '';
  document.getElementById('cust-form-phone').value = '';
  document.getElementById('cust-form-address').value = '';
  document.getElementById('cust-form-area').value = 'Main Area';
  document.getElementById('cust-form-given').value = state.settings.defaultGivenAmount || 10000;
  document.getElementById('cust-form-margin').value = '4.0';
  document.getElementById('cust-form-instalments').value = state.settings.defaultInstalments || 52;
  document.getElementById('cust-form-amount').value = state.settings.defaultInstalmentAmount || 200;
  document.getElementById('cust-form-date').value = new Date().toISOString().split('T')[0];

  calculateFromMargin();
  document.getElementById('modal-customer').classList.add('active');
}

// Open Edit Customer Modal
function openEditCustomerModal(customerId) {
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  const loanNum = c.loanNumber || 1;
  document.getElementById('modal-customer-title').textContent = `Edit Customer #${c.customerNumber} (Loan #${loanNum})`;
  document.getElementById('form-customer-id').value = c.id;
  document.getElementById('cust-form-loan-number').value = loanNum;
  document.getElementById('cust-form-number').value = c.customerNumber;
  document.getElementById('cust-form-number').readOnly = false;
  document.getElementById('cust-form-name').value = c.fullName;
  document.getElementById('cust-form-name').readOnly = false;
  document.getElementById('cust-form-phone').value = c.phone || '';
  document.getElementById('cust-form-address').value = c.address || '';
  document.getElementById('cust-form-area').value = c.areaRoute || '';
  document.getElementById('cust-form-given').value = c.givenAmount;
  document.getElementById('cust-form-instalments').value = c.totalInstalments || 52;
  document.getElementById('cust-form-amount').value = c.instalmentAmount || 200;
  document.getElementById('cust-form-date').value = c.startDate || new Date().toISOString().split('T')[0];

  const wrap = document.getElementById('existing-customer-selector-wrap');
  if (wrap) wrap.style.display = 'none';

  calculateFromAmount();
  document.getElementById('modal-customer').classList.add('active');
}

// Save Customer (Create or Update with Multi-Loan support)
function handleSaveCustomer(event) {
  event.preventDefault();

  const id = document.getElementById('form-customer-id').value;
  const customerNumber = document.getElementById('cust-form-number').value.trim();
  const loanNumber = Number(document.getElementById('cust-form-loan-number')?.value) || 1;
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

  // Check duplicate customer number AND loan number combination
  const duplicate = state.customers.find((c) =>
    c.customerNumber.toString() === customerNumber &&
    (Number(c.loanNumber) || 1) === loanNumber &&
    c.id !== id
  );

  if (duplicate) {
    alert(`Customer #${customerNumber} Loan #${loanNumber} already exists. Please choose a different loan number.`);
    return;
  }

  if (id) {
    // Edit existing loan
    const existing = state.customers.find((c) => c.id === id);
    if (existing) {
      existing.customerNumber = customerNumber;
      existing.loanNumber = loanNumber;
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
    // Create new customer or additional loan
    const newId = 'CUST-' + customerNumber + '-L' + loanNumber + '-' + Date.now();
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
      loanNumber,
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

    if (loanNumber === 1) {
      state.settings.nextCustNumber = Math.max(state.settings.nextCustNumber || 1, Number(customerNumber) + 1);
    }
  }

  saveData();
  const savedCust = state.customers.find((c) => c.customerNumber.toString() === customerNumber && (c.loanNumber || 1) === loanNumber);
  if (savedCust && typeof syncCustomerToFirestore === 'function') {
    syncCustomerToFirestore(savedCust);
  }
  closeModal('modal-customer');
  renderCustomersTable();
  renderCollectionMatrix();
  renderDashboard();
  showToast(`Customer #${customerNumber} (Loan #${loanNumber}) saved successfully!`);
}

// Delete Customer / Loan
function deleteCustomer(customerId) {
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  const loanLabel = (c.loanNumber && c.loanNumber > 1) ? ` (Loan #${c.loanNumber})` : '';
  if (confirm(`Are you sure you want to delete Customer #${c.customerNumber}${loanLabel} (${c.fullName})? All collection records for this loan will be removed.`)) {
    state.customers = state.customers.filter((cust) => cust.id !== customerId);
    saveData();
    if (typeof deleteCustomerFromFirestore === 'function') {
      deleteCustomerFromFirestore(customerId);
    }
    renderCustomersTable();
    renderCollectionMatrix();
    renderDashboard();
    showToast(`Customer #${c.customerNumber}${loanLabel} deleted.`);
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

  const loanSuffix = (c.loanNumber && c.loanNumber > 1) ? ` (Loan #${c.loanNumber})` : '';
  const loanBadgeHtml = (c.loanNumber && c.loanNumber > 1) ? ` <span class="loan-badge">L${c.loanNumber}</span>` : '';

  document.getElementById('passbook-modal-title').textContent = `Customer Passbook - #${c.customerNumber}${loanSuffix}: ${c.fullName}`;
  document.getElementById('passbook-header-info').innerHTML = `
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; background:#f1f5f9; padding:14px; border-radius:8px; margin-bottom:16px;">
      <div><span style="color:#64748b; font-size:12px;">Customer:</span><br><strong>#${c.customerNumber}${loanBadgeHtml} - ${c.fullName}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Phone:</span><br><strong>${c.phone || 'N/A'}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Given Amount:</span><br><strong style="color:#1e3a8a;">${formatMoney(c.givenAmount)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Instalment:</span><br><strong>${formatMoney(c.instalmentAmount)} /wk</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Total Repayable:</span><br><strong style="color:#1e293b;">${formatMoney(stats.totalPayable)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Total Paid:</span><br><strong style="color:#16a34a;">${formatMoney(stats.totalPaid)} (${stats.paidCount}/${totalInst})</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Balance Due:</span><br><strong style="color:#b45309;">${formatMoney(stats.balance)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Expected Net Profit:</span><br><strong style="color:#7c3aed;">+ ${formatMoney(stats.expectedProfit)} (${stats.profitReturnPercent}%)</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Profit Earned:</span><br><strong style="color:#16a34a;">${formatMoney(stats.realizedProfit)}</strong></div>
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
    `*${state.settings.businessName}*\nCustomer: #${c.customerNumber}${loanSuffix} - ${c.fullName}\nGiven Amount: ${formatMoney(c.givenAmount)}\nInstalments Paid: ${stats.paidCount}/${totalInst}\nTotal Paid: ${formatMoney(stats.totalPaid)}\nBalance Remaining: ${formatMoney(stats.balance)}\nThank you!`
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
  // Navigation tabs (Desktop & Mobile)
  document.querySelectorAll('.nav-link').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(link.dataset.tab);
    });
  });

  document.querySelectorAll('.mobile-nav-item').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      switchTab(item.dataset.tab);
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

  // Dynamic profit calculation listeners on customer form inputs
  ['cust-form-given', 'cust-form-instalments', 'cust-form-amount', 'cust-form-margin'].forEach((id) => {
    const inputEl = document.getElementById(id);
    if (inputEl) {
      inputEl.addEventListener('input', updateCustomerModalProfitCalc);
    }
  });

  // Recent Received Instalments Feed interactive filters
  const recentDate = document.getElementById('recent-date-filter');
  if (recentDate) recentDate.addEventListener('change', renderRecentTransactions);

  const recentSearch = document.getElementById('recent-search-filter');
  if (recentSearch) recentSearch.addEventListener('input', renderRecentTransactions);

  const recentRoute = document.getElementById('recent-route-filter');
  if (recentRoute) recentRoute.addEventListener('change', renderRecentTransactions);

  // Left Menu Hover-to-Open & Click-to-Close behavior
  const sidebar = document.getElementById('app-sidebar');
  if (sidebar) {
    sidebar.addEventListener('mouseleave', () => {
      sidebar.classList.remove('force-collapsed');
    });
  }
}

// Start application when DOM is ready
window.addEventListener('DOMContentLoaded', initApp);
