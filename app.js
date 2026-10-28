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
  minGivenAmount: 1000,
  defaultGivenAmount: 10000,
  defaultInstalments: 52,
  defaultInstalmentAmount: 250,
  autoCustNumbering: true,
  nextCustNumber: 1,
  adminEmail: 'singarisurendra@gmail.com',
  collectors: [
    { id: 'col_1', name: 'Raju Sharma', email: 'raju.collector@jsrfinance.com', phone: '+91 9876543211', route: 'Market Ward A', active: true },
    { id: 'col_2', name: 'Vikas Kumar', email: 'vikas.collector@jsrfinance.com', phone: '+91 9876543212', route: 'North Village Route', active: true }
  ],
};

const DEFAULT_SCHEMES = [
  {
    id: 'SCH-52W-STD',
    name: '52 Weeks Standard (₹10,000 / ₹250 wk)',
    totalInstalments: 52,
    frequency: 'Weekly',
    givenAmount: 10000,
    instalmentAmount: 250,
    totalPayable: 13000,
    description: 'Standard 52 weekly instalments of ₹250 for ₹10,000 loan (30% Flat Margin)',
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
  transactions: [],
  activeTab: 'collections',
  searchQuery: '',
  filterStatus: 'active',
  customerSearchQuery: '',
  customerFilterStatus: 'all',
  customerFilterRoute: 'all',
  customerFilterFrequency: 'all',
  customerFilterSort: 'id-asc',
  expandedCustomerIds: new Set(),
  allExpanded: false,
  pendingModifications: {},
  unsavedPromptCallback: null,
  activeLocks: {},
  offlineSyncQueue: JSON.parse(localStorage.getItem('jsr_finance_offline_queue') || '[]'),
  activeDetailCustomerId: null,
};
window.state = state;

// Unique Session ID for Multi-User & Multi-Tab Concurrency Control
if (!window.CURRENT_SESSION_ID) {
  window.CURRENT_SESSION_ID = 'sess_' + Math.random().toString(36).substring(2, 9) + '_' + Date.now();
}
var CURRENT_SESSION_ID = window.CURRENT_SESSION_ID;

// Helper to get formatted display name of currently active operator
function getCurrentUserDisplayName() {
  if (typeof getCurrentUser === 'function') {
    const u = getCurrentUser();
    if (u) {
      if (u.email) return u.email;
      if (u.username) return u.username;
      if (u.name) return u.name;
    }
  }
  try {
    const auth = JSON.parse(localStorage.getItem('jsr_auth_session') || '{}');
    if (auth.email) return auth.email;
    if (auth.username) return auth.username;
  } catch (e) {}
  return 'Another User';
}

// Find next free customer number starting from candidate without gap skipping
function findNextAvailableCustomerNumber(preferred = 1) {
  const existingNums = new Set((state.customers || []).map(c => Number(c.customerNumber)).filter(n => !isNaN(n) && n > 0));
  let candidate = Math.max(1, Number(preferred) || 1);
  while (existingNums.has(candidate)) {
    candidate++;
  }
  return candidate;
}

// ====================================================
// REAL-TIME COLLABORATIVE EDIT LOCK CONTROLLERS
// ====================================================
let _lockHeartbeatInterval = null;

// Check if a customer has non-zero net differences between their current modified state and initial state
function hasActualPendingChanges(customerId) {
  const pending = state.pendingModifications && state.pendingModifications[customerId];
  if (!pending) return false;
  const init = pending.initialInstalments || [];
  const curr = pending.modifiedInstalments || [];
  if (init.length !== curr.length) return true;
  for (let i = 0; i < curr.length; i++) {
    const a = init[i] || {};
    const b = curr[i] || {};
    const aStatus = a.status || 'Pending';
    const bStatus = b.status || 'Pending';
    const aPaid = Number(a.paidAmount || 0);
    const bPaid = Number(b.paidAmount || 0);
    if (aStatus !== bStatus || aPaid !== bPaid) {
      return true;
    }
  }
  return false;
}

function getActiveEditLock(customerId) {
  if (!state.activeLocks || !state.activeLocks[customerId]) return null;
  const lock = state.activeLocks[customerId];
  const now = Date.now();
  if (!lock || !lock.expiresAt || Number(lock.expiresAt) <= now) return null;
  if (lock.sessionId === CURRENT_SESSION_ID) return null; // Current tab owns the lock
  return lock;
}

function acquireEditLock(customerId) {
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return false;

  const existingLock = getActiveEditLock(customerId);
  if (existingLock) {
    return false; // Locked by another active user
  }

  const userName = getCurrentUserDisplayName();
  const now = Date.now();
  const lockData = {
    customerId,
    customerNumber: customer.customerNumber,
    customerName: customer.fullName,
    lockedBy: userName,
    sessionId: CURRENT_SESSION_ID,
    lockedAt: now,
    expiresAt: now + 45000 // 45 seconds lease
  };

  if (!state.activeLocks) state.activeLocks = {};
  state.activeLocks[customerId] = lockData;

  try {
    localStorage.setItem('jsr_finance_editing_locks', JSON.stringify(state.activeLocks));
  } catch (e) {}

  if (typeof syncEditLockToFirestore === 'function') {
    syncEditLockToFirestore(lockData);
  }

  if (!_lockHeartbeatInterval) {
    _lockHeartbeatInterval = setInterval(refreshActiveLocksHeartbeat, 15000);
  }
  return true;
}

function refreshActiveLocksHeartbeat() {
  const pendingIds = Object.keys(state.pendingModifications || {});
  if (pendingIds.length === 0) {
    if (_lockHeartbeatInterval) {
      clearInterval(_lockHeartbeatInterval);
      _lockHeartbeatInterval = null;
    }
    return;
  }

  const now = Date.now();
  pendingIds.forEach((cid) => {
    // If user has reverted all changes, immediately clean up and release lock!
    if (!hasActualPendingChanges(cid)) {
      delete state.pendingModifications[cid];
      if (typeof releaseEditLock === 'function') {
        releaseEditLock(cid);
      }
      return;
    }

    const cur = state.activeLocks && state.activeLocks[cid];
    if (cur && cur.sessionId === CURRENT_SESSION_ID) {
      cur.expiresAt = now + 45000;
      if (typeof syncEditLockToFirestore === 'function') {
        syncEditLockToFirestore(cur);
      }
    }
  });
}

function releaseEditLock(customerId) {
  if (state.activeLocks && state.activeLocks[customerId]) {
    const lock = state.activeLocks[customerId];
    if (lock.sessionId === CURRENT_SESSION_ID) {
      delete state.activeLocks[customerId];
      try {
        localStorage.setItem('jsr_finance_editing_locks', JSON.stringify(state.activeLocks));
      } catch (e) {}
      if (typeof deleteEditLockFromFirestore === 'function') {
        deleteEditLockFromFirestore(customerId);
      }
    }
  }

  const ourLocks = Object.values(state.activeLocks || {}).filter(l => l && l.sessionId === CURRENT_SESSION_ID);
  if (ourLocks.length === 0 && _lockHeartbeatInterval) {
    clearInterval(_lockHeartbeatInterval);
    _lockHeartbeatInterval = null;
  }
}

// Fallback manual or remote refresh to clear expired/released locks directly from Firestore
async function checkAndRefreshCustomerLock(customerId) {
  if (typeof showToast === 'function') {
    showToast('🔍 Checking lock status with Google Cloud Firestore...');
  }
  if (typeof firestoreDb !== 'undefined' && firestoreDb && typeof isCloudSyncActive !== 'undefined' && isCloudSyncActive) {
    try {
      const docSnap = await firestoreDb.collection('editing_locks').doc(customerId).get();
      if (!docSnap.exists) {
        if (state.activeLocks && state.activeLocks[customerId]) {
          delete state.activeLocks[customerId];
          try {
            localStorage.setItem('jsr_finance_editing_locks', JSON.stringify(state.activeLocks));
          } catch (e) {}
        }
        showToast('✅ Lock has been released! You can now edit.', 3000);
        renderCollectionMatrix();
        return;
      }
      const data = docSnap.data();
      const now = Date.now();
      if (!data || !data.expiresAt || Number(data.expiresAt) <= now) {
        await firestoreDb.collection('editing_locks').doc(customerId).delete();
        if (state.activeLocks && state.activeLocks[customerId]) {
          delete state.activeLocks[customerId];
          try {
            localStorage.setItem('jsr_finance_editing_locks', JSON.stringify(state.activeLocks));
          } catch (e) {}
        }
        showToast('✅ Expired lock released! You can now edit.', 3000);
        renderCollectionMatrix();
        return;
      }
      showToast(`🔒 Still locked by ${data.lockedBy || 'another user'}. Lease active.`, 3000);
    } catch (err) {
      console.warn('Error checking lock:', err);
    }
  } else {
    const lock = state.activeLocks && state.activeLocks[customerId];
    if (!lock || Number(lock.expiresAt) <= Date.now()) {
      if (state.activeLocks && state.activeLocks[customerId]) {
        delete state.activeLocks[customerId];
        try {
          localStorage.setItem('jsr_finance_editing_locks', JSON.stringify(state.activeLocks));
        } catch (e) {}
      }
      renderCollectionMatrix();
    }
  }
}
window.checkAndRefreshCustomerLock = checkAndRefreshCustomerLock;

// Release locks automatically if user closes window or navigates away
window.addEventListener('beforeunload', () => {
  if (state.activeLocks) {
    Object.values(state.activeLocks).forEach((l) => {
      if (l && l.sessionId === CURRENT_SESSION_ID && l.customerId) {
        if (typeof deleteEditLockFromFirestore === 'function') {
          deleteEditLockFromFirestore(l.customerId);
        }
      }
    });
  }
});

// Web Audio API Cash Register Chime & Sound Effects (Zero External Files)
function playCashChime() {
  if (state.settings && state.settings.soundMuted) return;
  try {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const ctx = new AudioContextClass();
    if (ctx.state === 'suspended') {
      ctx.resume();
    }
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();

    osc.type = 'sine';
    const now = ctx.currentTime;
    // Ascending cash ding tone: 880Hz (A5) -> 1320Hz (E6)
    osc.frequency.setValueAtTime(880, now);
    osc.frequency.exponentialRampToValueAtTime(1320, now + 0.12);

    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.35);

    osc.connect(gain);
    gain.connect(ctx.destination);

    osc.start(now);
    osc.stop(now + 0.35);
  } catch (e) {
    // Graceful fallback if audio is restricted before first gesture
  }
}

function toggleSoundEffect() {
  if (!state.settings) state.settings = {};
  state.settings.soundMuted = !state.settings.soundMuted;
  saveData();
  updateSoundToggleButton();
  if (!state.settings.soundMuted) {
    playCashChime();
    showToast('Sound effects enabled 🔔');
  } else {
    showToast('Sound effects muted 🔕');
  }
}

function updateSoundToggleButton() {
  const isMuted = !!(state.settings && state.settings.soundMuted);

  // Top header button (if present)
  const topBtn = document.getElementById('btn-sound-toggle');
  if (topBtn) {
    topBtn.innerHTML = isMuted ? '🔕 Sound: Off' : '🔔 Sound: On';
    topBtn.style.color = isMuted ? '#94a3b8' : '#15803d';
  }

  // Settings screen button & status badge
  const settingBtn = document.getElementById('setting-sound-toggle-btn');
  const settingBadge = document.getElementById('setting-sound-status-badge');
  if (settingBtn) {
    if (isMuted) {
      settingBtn.className = 'btn btn-outline';
      settingBtn.innerHTML = '🔕 Sound: OFF (Click to Turn ON)';
    } else {
      settingBtn.className = 'btn btn-primary';
      settingBtn.innerHTML = '🔔 Sound: ON (Click to Mute)';
    }
  }
  if (settingBadge) {
    if (isMuted) {
      settingBadge.style.background = '#f1f5f9';
      settingBadge.style.color = '#64748b';
      settingBadge.textContent = 'Sound: OFF';
    } else {
      settingBadge.style.background = '#dcfce7';
      settingBadge.style.color = '#15803d';
      settingBadge.textContent = 'Sound: ON';
    }
  }
}

// Helper: Group Customers by Customer Number (Multi-Loan Support)
function getGroupedCustomers() {
  const groups = {};
  (state.customers || []).forEach((c) => {
    if (!c || !c.customerNumber) return;
    const num = c.customerNumber.toString();
    if (!groups[num]) {
      groups[num] = [];
    }
    groups[num].push(c);
  });

  const result = [];
  Object.keys(groups).sort((a, b) => Number(a) - Number(b)).forEach((num) => {
    const loans = groups[num];
    // Sort active loans first, then descending loanNumber
    loans.sort((a, b) => {
      const statsA = getCustomerStats(a);
      const statsB = getCustomerStats(b);
      if (!statsA.isCompleted && statsB.isCompleted) return -1;
      if (statsA.isCompleted && !statsB.isCompleted) return 1;
      return (Number(b.loanNumber) || 1) - (Number(a.loanNumber) || 1);
    });

    const activeLoan = loans[0];
    result.push({
      customerNumber: num,
      fullName: activeLoan.fullName,
      phone: activeLoan.phone,
      areaRoute: activeLoan.areaRoute,
      activeLoan: activeLoan,
      loans: loans,
    });
  });
  return result;
}

// Universal Customer Search & ID Matcher (Supports #1, 1, 001, CUS001, cus001, CUS-1, 1-2, L2, Phone, Route, Name)
function customerMatchesQuery(c, query) {
  if (!query) return true;
  const q = String(query).toLowerCase().trim();
  if (!q) return true;

  const numStr = (c.customerNumber || '').toString().toLowerCase();
  const nameStr = (c.fullName || '').toLowerCase();
  const phoneStr = (c.phone || '').toLowerCase();
  const routeStr = (c.areaRoute || '').toLowerCase();
  const docIdStr = (c.id || '').toLowerCase();
  const loanNum = Number(c.loanNumber) || 1;
  const loanBadge = `l${loanNum}`;

  // Formats of customer ID: e.g. "1", "#1", "001", "cus001", "cus1", "cus-1", "cus 1"
  const padded3 = numStr.padStart(3, '0');
  const codePadded = `cus${padded3}`;
  const codeDirect = `cus${numStr}`;
  const codeHyphen = `cus-${numStr}`;
  const codeSpace = `cus ${numStr}`;
  const prefixHash = `#${numStr}`;

  // Loan combinations: e.g. "1-2", "1 - 2", "1/2", "1l2", "1 l2", "#1 l2", "#1-l2", "cus001 l2", "cus001-l2"
  const combo1 = `${numStr}-${loanNum}`;
  const combo2 = `${numStr} ${loanBadge}`;
  const combo3 = `${numStr}/${loanNum}`;
  const combo4 = `${prefixHash} ${loanBadge}`;
  const combo5 = `${prefixHash}-${loanBadge}`;
  const combo6 = `${codePadded} ${loanBadge}`;
  const combo7 = `${codePadded}-${loanBadge}`;

  // Direct substring matches
  if (
    numStr.includes(q) ||
    nameStr.includes(q) ||
    phoneStr.includes(q) ||
    routeStr.includes(q) ||
    docIdStr.includes(q) ||
    padded3.includes(q) ||
    codePadded.includes(q) ||
    codeDirect.includes(q) ||
    codeHyphen.includes(q) ||
    codeSpace.includes(q) ||
    prefixHash.includes(q) ||
    loanBadge.includes(q) ||
    combo1.includes(q) ||
    combo2.includes(q) ||
    combo3.includes(q) ||
    combo4.includes(q) ||
    combo5.includes(q) ||
    combo6.includes(q) ||
    combo7.includes(q)
  ) {
    return true;
  }

  // Normalized alphanumeric check (ignores punctuation, hashes, whitespace)
  const cleanQ = q.replace(/[^a-z0-9]/g, '');
  if (cleanQ) {
    if (
      numStr === cleanQ ||
      padded3 === cleanQ ||
      codePadded === cleanQ ||
      codeDirect === cleanQ ||
      `${numStr}${loanNum}` === cleanQ ||
      `${numStr}l${loanNum}` === cleanQ ||
      `${codePadded}l${loanNum}` === cleanQ ||
      cleanQ === `l${loanNum}` ||
      cleanQ === `loan${loanNum}`
    ) {
      return true;
    }
  }

  return false;
}

// Open and highlight a specific customer schedule in the Collections view
function openCustomerScheduleDirect(customerId) {
  switchTab('collections');
  
  // Reset filters so completed/settled loans or specific filters don't hide the customer
  state.filterStatus = 'all';
  const filterSelect = document.getElementById('collection-filter-select');
  if (filterSelect) filterSelect.value = 'all';

  state.collectionLoanFilter = 'all';
  const loanFilterSelect = document.getElementById('collection-loan-filter');
  if (loanFilterSelect) loanFilterSelect.value = 'all';

  state.searchQuery = '';
  const searchInput = document.getElementById('global-search-input');
  if (searchInput) searchInput.value = '';

  if (!state.expandedCustomerIds) state.expandedCustomerIds = new Set();
  state.expandedCustomerIds.clear();
  state.expandedCustomerIds.add(customerId);
  renderCollectionMatrix();
  setTimeout(() => {
    const card = document.querySelector(`.cust-compact-card[data-customer-id="${customerId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.style.outline = '2px solid #2563eb';
      card.style.borderRadius = '12px';
      card.style.transition = 'outline 0.3s ease';
      setTimeout(() => { card.style.outline = 'none'; }, 2500);
    }
  }, 120);
}

// Interactive Tooltip Popover for Customer Loans Breakdown
function toggleLoansTooltip(event, customerNumber) {
  if (event && event.stopPropagation) {
    event.stopPropagation();
  }
  const popover = document.getElementById('loans-tooltip-popover');
  const backdrop = document.getElementById('loans-popover-backdrop');
  if (!popover) return;

  if (popover.dataset.openCust === customerNumber && popover.style.display !== 'none' && popover.style.display !== '') {
    hideLoansTooltip();
    return;
  }

  const grouped = getGroupedCustomers();
  const custGroup = grouped.find((g) => g.customerNumber === customerNumber);
  if (!custGroup) return;

  let totalDisbursed = 0;
  let totalPaid = 0;
  let totalBalance = 0;

  custGroup.loans.forEach((loan) => {
    totalDisbursed += (Number(loan.givenAmount) || 0);
    const s = getCustomerStats(loan);
    totalPaid += s.totalPaid;
    totalBalance += s.balance;
  });

  let html = `
    <div class="loans-tooltip-header">
      <span style="display: flex; align-items: center; gap: 8px;">
        <span style="font-size: 16px;">💳</span>
        <span style="font-weight: 800; font-size: 13.5px; color: #0f172a;">Loans for #${custGroup.customerNumber} - ${custGroup.fullName}</span>
      </span>
      <button type="button" class="modal-close" style="font-size: 20px; line-height: 1; padding: 2px 8px; cursor: pointer;" onclick="hideLoansTooltip()">&times;</button>
    </div>

    <!-- Customer Aggregate Loans Summary Banner -->
    <div class="loans-customer-summary-card">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
        <span style="font-size: 11px; font-weight: 700; color: #1e40af; text-transform: uppercase; letter-spacing: 0.3px;">Customer Loans Summary</span>
        <span style="font-size: 11px; background: #dbeafe; color: #1d4ed8; padding: 2px 7px; border-radius: 9999px; font-weight: 700;">${custGroup.loans.length} ${custGroup.loans.length === 1 ? 'Loan' : 'Loans'}</span>
      </div>
      <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 6px; text-align: center;">
        <div>
          <div style="font-size: 10px; color: #64748b; font-weight: 600;">Disbursed</div>
          <div style="font-size: 13px; font-weight: 800; color: #1e3a8a;">${formatMoney(totalDisbursed)}</div>
        </div>
        <div>
          <div style="font-size: 10px; color: #64748b; font-weight: 600;">Collected</div>
          <div style="font-size: 13px; font-weight: 800; color: #16a34a;">${formatMoney(totalPaid)}</div>
        </div>
        <div>
          <div style="font-size: 10px; color: #64748b; font-weight: 600;">Balance</div>
          <div style="font-size: 13px; font-weight: 800; color: #b45309;">${formatMoney(totalBalance)}</div>
        </div>
      </div>
    </div>

    <div class="loans-tooltip-body">
  `;

  custGroup.loans.forEach((loan, idx) => {
    const stats = getCustomerStats(loan);
    const isCurrent = loan.id === custGroup.activeLoan.id;
    const loanNum = Number(loan.loanNumber) || (idx + 1);
    const statusBadge = stats.isCompleted 
      ? '<span style="color: #16a34a; font-weight: 700; font-size: 11.5px; background: #dcfce7; padding: 2px 7px; border-radius: 9999px;">✓ Completed</span>'
      : '<span style="color: #2563eb; font-weight: 700; font-size: 11.5px; background: #eff6ff; padding: 2px 7px; border-radius: 9999px;">Active Loan</span>';

    html += `
      <div class="loans-tooltip-item ${isCurrent ? 'active' : ''}">
        <div class="loans-tooltip-loan-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <strong style="color: #0f172a; font-size: 13px;">Loan #${loanNum} (${loan.frequency || 'Weekly'})</strong>
          <span>${statusBadge}</span>
        </div>
        <div class="loans-tooltip-stat" style="font-size: 12px; line-height: 1.6; color: #475569;">
          • <strong>Disbursed:</strong> ${formatMoney(loan.givenAmount)} (${formatMoney(loan.instalmentAmount)} / ${loan.frequency === 'Daily' ? 'day' : 'wk'})<br>
          • <strong>Instalments:</strong> ${stats.paidCount} of ${loan.totalInstalments || 52} Paid<br>
          • <strong>Balance:</strong> <span style="color: #b45309; font-weight: 700;">${formatMoney(stats.balance)}</span>
        </div>
        <div style="margin-top: 8px; display: flex; justify-content: flex-end;">
          <button type="button" class="btn btn-outline btn-sm" onclick="hideLoansTooltip(); openCustomerPassbook('${loan.id}')" style="font-size: 11.5px; padding: 4px 10px; color: #1e40af; border-color: #bfdbfe; background: #eff6ff;">
            View Passbook ↗
          </button>
        </div>
      </div>
    `;
  });

  html += `
    </div>
    <div class="loans-tooltip-footer">
      <button type="button" class="btn btn-primary" onclick="hideLoansTooltip(); openAddLoanForCustomer('${custGroup.customerNumber}')" style="width: 100%; font-size: 13px; padding: 10px 14px; font-weight: 700; justify-content: center;">
        + Issue Additional Loan
      </button>
    </div>
  `;
  popover.innerHTML = html;
  popover.dataset.openCust = customerNumber;
  popover.style.display = 'flex';
  popover.style.top = '';
  popover.style.left = '';
  popover.style.right = '';
  popover.style.bottom = '';
  popover.style.transform = '';
  if (backdrop) backdrop.style.display = 'block';
  document.body.classList.add('modal-open');
}

function hideLoansTooltip() {
  const popover = document.getElementById('loans-tooltip-popover');
  const backdrop = document.getElementById('loans-popover-backdrop');
  if (popover) {
    popover.style.display = 'none';
    popover.dataset.openCust = '';
  }
  if (backdrop) {
    backdrop.style.display = 'none';
  }
  if (!document.querySelector('.modal-overlay.active')) {
    document.body.classList.remove('modal-open');
  }
}

// Interactive 3-Dot Actions Menu Popover for Customer Pro Actions
function toggleCustomerActionsMenu(event, customerId) {
  if (event && event.stopPropagation) {
    event.stopPropagation();
  }
  const popover = document.getElementById('cust-actions-menu-popover');
  const backdrop = document.getElementById('cust-actions-backdrop');
  if (!popover) return;

  if (popover.dataset.openCust === customerId && popover.style.display !== 'none' && popover.style.display !== '') {
    hideCustomerActionsMenu();
    return;
  }

  const cust = state.customers.find(c => c.id === customerId);
  if (!cust) return;

  const stats = getCustomerStats(cust);
  const totalInst = cust.totalInstalments || 52;
  const nextDueSeq = (cust.instalments || []).findIndex(i => !i || i.status !== 'Received') + 1 || totalInst;

  let avatarInner = cust.fullName ? cust.fullName.charAt(0).toUpperCase() : 'C';
  if (cust.photoUrl) {
    avatarInner = `<img src="${cust.photoUrl}" style="width:100%; height:100%; object-fit:cover;">`;
  }

  popover.innerHTML = `
    <div class="cust-menu-header">
      <div style="display:flex; align-items:center; gap:10px;">
        <div style="width:36px; height:36px; border-radius:50%; overflow:hidden; background:#2563eb; color:#fff; display:flex; align-items:center; justify-content:center; font-weight:800; font-size:14px; flex-shrink:0;">
          ${avatarInner}
        </div>
        <div>
          <div style="font-weight:800; font-size:14px; color:#0f172a;">#${cust.customerNumber} - ${cust.fullName} <span class="cust-loan-badge">L${cust.loanNumber || 1}</span></div>
          <div style="font-size:11.5px; color:#64748b;">${cust.phone || 'No phone'} • Bal: <strong style="color:#b45309;">${formatMoney(stats.balance)}</strong></div>
        </div>
      </div>
      <button type="button" class="modal-close" onclick="hideCustomerActionsMenu()" style="font-size:22px; cursor:pointer; background:none; border:none; color:#64748b;">&times;</button>
    </div>

    <div class="cust-menu-body">
      <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); openCustomerPassbook('${cust.id}')">
        <span class="cust-menu-icon" style="background:#eff6ff; color:#1e40af;">🧾</span>
        <div>
          <div class="cust-menu-item-title">Customer Passbook & Statement</div>
          <div class="cust-menu-item-desc">Chronological statement, company letterhead & signatures</div>
        </div>
      </button>

      <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); openThermalReceiptModal('${cust.id}', ${nextDueSeq > 1 ? nextDueSeq - 1 : 1})">
        <span class="cust-menu-icon" style="background:#f1f5f9; color:#334155;">🖨️</span>
        <div>
          <div class="cust-menu-item-title">Pocket Thermal Slip (58mm)</div>
          <div class="cust-menu-item-desc">Wireless Bluetooth print or instant 58mm browser print</div>
        </div>
      </button>

      <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); openKycViewerModal('${cust.id}')">
        <span class="cust-menu-icon" style="background:#ecfdf5; color:#047857;">🪪</span>
        <div>
          <div class="cust-menu-item-title">Borrower KYC Vault & Docs</div>
          <div class="cust-menu-item-desc">${cust.kycVerified ? '✓ Verified identity proof & camera photo' : 'Inspect uploaded borrower ID documents'}</div>
        </div>
      </button>

      ${!cust.isSettled && stats.balance > 0 ? `
        <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); openSettlementModal('${cust.id}')">
          <span class="cust-menu-icon" style="background:#faf5ff; color:#7c3aed;">🤝</span>
          <div>
            <div class="cust-menu-item-title" style="color:#7c3aed;">Early Loan Foreclosure & Settlement</div>
            <div class="cust-menu-item-desc">Calculate rebate discount, settle remaining balance & issue NOC</div>
          </div>
        </button>
      ` : (cust.isSettled ? `
        <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); openNOCModal('${cust.id}')">
          <span class="cust-menu-icon" style="background:#fef3c7; color:#92400e;">📜</span>
          <div>
            <div class="cust-menu-item-title" style="color:#92400e;">View Official NOC Certificate</div>
            <div class="cust-menu-item-desc">No Objection Certificate with legal seal & clearance</div>
          </div>
        </button>
      ` : '')}

      ${(cust.guarantor && cust.guarantor.phone) ? `
        <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); contactGuarantor('${cust.id}', 'whatsapp')">
          <span class="cust-menu-icon" style="background:#f0fdf4; color:#16a34a;">💬</span>
          <div>
            <div class="cust-menu-item-title" style="color:#16a34a;">WhatsApp Guarantor / Surety</div>
            <div class="cust-menu-item-desc">Send 1-tap notice to ${cust.guarantor.name} (${cust.guarantor.phone})</div>
          </div>
        </button>
        <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); contactGuarantor('${cust.id}', 'call')">
          <span class="cust-menu-icon" style="background:#eff6ff; color:#2563eb;">📞</span>
          <div>
            <div class="cust-menu-item-title">Call Guarantor Directly</div>
            <div class="cust-menu-item-desc">Dial ${cust.guarantor.phone} (${cust.guarantor.rel || 'Surety'})</div>
          </div>
        </button>
      ` : ''}

      <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); openAddLoanForCustomer('${cust.customerNumber}')">
        <span class="cust-menu-icon" style="background:#eff6ff; color:#2563eb;">➕</span>
        <div>
          <div class="cust-menu-item-title" style="color:#2563eb;">Issue Additional Loan</div>
          <div class="cust-menu-item-desc">Disburse a new loan account (L2, L3) for this customer</div>
        </div>
      </button>

      <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); sendWhatsAppDueReminder('${cust.id}')">
        <span class="cust-menu-icon" style="background:#f0fdf4; color:#16a34a;">💬</span>
        <div>
          <div class="cust-menu-item-title" style="color:#16a34a;">Send WhatsApp Reminder</div>
          <div class="cust-menu-item-desc">Send due date / outstanding balance statement to ${cust.phone || 'borrower'}</div>
        </div>
      </button>

      <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); openEditCustomerModal('${cust.id}')">
        <span class="cust-menu-icon" style="background:#f8fafc; color:#475569;">✏️</span>
        <div>
          <div class="cust-menu-item-title">Edit Customer Profile</div>
          <div class="cust-menu-item-desc">Update phone number, address, route, or surety</div>
        </div>
      </button>

      <button type="button" class="cust-menu-item" onclick="hideCustomerActionsMenu(); deleteCustomer('${cust.id}')" style="border-color:#fecaca;">
        <span class="cust-menu-icon" style="background:#fef2f2; color:#dc2626;">🗑️</span>
        <div>
          <div class="cust-menu-item-title" style="color:#dc2626;">Delete Customer / Loan</div>
          <div class="cust-menu-item-desc">Permanently remove this customer record and instalments</div>
        </div>
      </button>
    </div>
  `;

  popover.dataset.openCust = customerId;
  popover.style.display = 'flex';
  if (backdrop) backdrop.style.display = 'block';
  document.body.classList.add('modal-open');
}

function hideCustomerActionsMenu() {
  const popover = document.getElementById('cust-actions-menu-popover');
  const backdrop = document.getElementById('cust-actions-backdrop');
  if (popover) {
    popover.style.display = 'none';
    popover.dataset.openCust = '';
  }
  if (backdrop) {
    backdrop.style.display = 'none';
  }
  if (!document.querySelector('.modal-overlay.active') && (!document.getElementById('loans-tooltip-popover') || document.getElementById('loans-tooltip-popover').style.display === 'none')) {
    document.body.classList.remove('modal-open');
  }
}

// Global document click listener to close loans tooltip when clicking outside
document.addEventListener('click', (e) => {
  const popover = document.getElementById('loans-tooltip-popover');
  if (popover && popover.style.display !== 'none' && popover.style.display !== '') {
    if (!popover.contains(e.target) && !e.target.closest('.loans-badge')) {
      hideLoansTooltip();
    }
  }
  const actionsPopover = document.getElementById('cust-actions-menu-popover');
  if (actionsPopover && actionsPopover.style.display !== 'none' && actionsPopover.style.display !== '') {
    if (!actionsPopover.contains(e.target) && !e.target.closest('.btn-cust-3dot')) {
      hideCustomerActionsMenu();
    }
  }
  if (e.target && e.target.classList && e.target.classList.contains('modal-overlay')) {
    closeModal(e.target.id);
  }
});

// Escape key to close any active modal or popover
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideLoansTooltip();
    hideCustomerActionsMenu();
    document.querySelectorAll('.modal-overlay.active').forEach(m => {
      closeModal(m.id);
    });
  }
});

// ====================================================
// AUTHENTICATION & SECURITY GATE (GOOGLE SSO + STRICT WHITELIST)
// ====================================================
const AUTH_KEY = 'jsr_auth_session';

const AUTHORIZED_OPERATOR_WHITELIST = [
  'admin@jsrfinance.com',
  'singarisurendra@gmail.com',
  'operator@jsrfinance.com',
  'singarisurendra-crypto@users.noreply.github.com'
];

function showGoogleAuthError(message) {
  const errorAlert = document.getElementById('login-error-alert');
  if (errorAlert) {
    errorAlert.innerHTML = `
      <div style="text-align: left; line-height: 1.5; width: 100%;">
        <strong style="color: #b91c1c;">🚫 Google Authentication Notice</strong><br>
        <span style="font-size: 12px; color: #475569;">${message}</span>
      </div>
    `;
    errorAlert.style.background = '#fef2f2';
    errorAlert.style.borderColor = '#fca5a5';
    errorAlert.style.color = '#b91c1c';
    errorAlert.style.display = 'flex';
  }
}

function handleGoogleSignInClick() {
  const label = document.getElementById('btn-google-sso-label');
  if (label) label.textContent = 'Connecting to Google...';

  const errorAlert = document.getElementById('login-error-alert');
  if (errorAlert) {
    errorAlert.style.display = 'none';
    errorAlert.style.background = '#fee2e2';
    errorAlert.style.borderColor = '#fecaca';
    errorAlert.style.color = '#dc2626';
  }

  // Ensure Google Cloud Firestore / Firebase is initialized
  if (typeof initGoogleCloudDatabase === 'function' && typeof firebase !== 'undefined' && !firebase.apps.length) {
    initGoogleCloudDatabase();
  }

  // Official Firebase Auth Google SSO Popup
  if (typeof firebase !== 'undefined' && firebase.auth) {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });

      firebase.auth().signInWithPopup(provider)
        .then((result) => {
          if (label) label.textContent = 'Sign In with Google';
          if (result && result.user && result.user.email) {
            verifyAndLoginGoogleUser(result.user.email, result.user.displayName || result.user.email);
          } else {
            showGoogleAuthError('No Google user credentials returned. Please try signing in again.');
          }
        })
        .catch((error) => {
          if (label) label.textContent = 'Sign In with Google';
          console.warn('Firebase Google Auth event:', error);
          if (error.code === 'auth/popup-blocked') {
            if (label) label.textContent = 'Redirecting to Google...';
            firebase.auth().signInWithRedirect(provider);
          } else if (error.code === 'auth/popup-closed-by-user') {
            // User closed the popup, leave screen ready for another attempt
          } else if (error.code === 'auth/operation-not-allowed' || error.code === 'auth/configuration-not-found') {
            showGoogleAuthError(
              'Google Provider is not enabled in Firebase Console yet. Please enable Google under Firebase Console > Authentication > Sign-in method.'
            );
          } else if (error.code === 'auth/unauthorized-domain') {
            showGoogleAuthError(
              'This domain is not authorized in Firebase Console > Authentication > Settings > Authorized domains. Please add this domain to log in.'
            );
          } else {
            showGoogleAuthError(error.message || 'Google Sign-In failed. Please try again.');
          }
        });
      return;
    } catch (e) {
      if (label) label.textContent = 'Sign In with Google';
      console.warn('Firebase Auth popup invocation failed:', e);
      showGoogleAuthError('Google Sign-In error: ' + (e.message || e));
      return;
    }
  }

  if (label) label.textContent = 'Sign In with Google';
  showGoogleAuthError('Google Authentication service is initializing. Please wait a moment and try again.');
}

function handleSyncPillClick() {
  switchTab('settings');
  if (typeof refreshSessionData === 'function') {
    refreshSessionData(false);
  }
  const sessIdElem = document.getElementById('settings-session-id');
  if (sessIdElem) sessIdElem.textContent = window.CURRENT_SESSION_ID || 'session_active';
  const card = document.getElementById('card-cloud-firebase-sync');
  if (card) {
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.style.transition = 'box-shadow 0.3s ease';
    card.style.boxShadow = '0 0 0 3px rgba(56, 189, 248, 0.7)';
    setTimeout(() => { card.style.boxShadow = ''; }, 2000);
  }
}

function verifyAndLoginGoogleUser(email, name) {
  const errorAlert = document.getElementById('login-error-alert');
  const normalizedEmail = (email || '').trim().toLowerCase();

  function grantAccess(role, assignedName, collectorId, route) {
    const sessionData = {
      user: assignedName || normalizedEmail,
      email: normalizedEmail,
      role: role || 'Admin',
      collectorId: collectorId || null,
      route: route || '',
      provider: 'Google SSO',
      loginTime: new Date().toISOString()
    };
    localStorage.setItem(AUTH_KEY, JSON.stringify(sessionData));
    
    const loginOverlay = document.getElementById('view-login');
    if (loginOverlay) {
      loginOverlay.style.opacity = '0';
      loginOverlay.style.transition = 'opacity 0.25s ease';
      setTimeout(() => {
        loginOverlay.style.display = 'none';
        loginOverlay.style.opacity = '1';
      }, 250);
    }
    playCashChime();
    showToast(`✓ Google Verified! Welcome, ${assignedName || normalizedEmail} (${role})`);

    // Immediately open instalment screen & refresh data
    loadData();
    updateHeaderStats();
    switchTab('collections');
    if (typeof initGoogleCloudDatabase === 'function' && (!firestoreDb || !isCloudSyncActive)) {
      initGoogleCloudDatabase();
    }
    applyRoleBasedPermissions();
  }

  function showDenied() {
    if (errorAlert) {
      errorAlert.innerHTML = `
        <div style="text-align: left; line-height: 1.5;">
          <strong>🚫 Access Denied (HTTP 403 Forbidden)</strong><br>
          <span style="font-size: 12px;">Account <code>${normalizedEmail}</code> is not registered on the operator roster. Contact your administrator (${state.settings.adminEmail || 'admin@jsrfinance.com'}) to grant access.</span>
        </div>
      `;
      errorAlert.style.display = 'flex';
    }
  }

  // 1. Check Registered Field Collectors Roster First (Honors exact assigned names like "Singari Suri")
  const collectorsList = (state && state.settings && Array.isArray(state.settings.collectors))
    ? state.settings.collectors
    : [];
  
  const matchedCollector = collectorsList.find(c => 
    c && c.email && c.email.trim().toLowerCase() === normalizedEmail && c.active !== false
  );

  if (matchedCollector) {
    grantAccess('Collector', matchedCollector.name, matchedCollector.id, matchedCollector.route);
    return;
  }

  // 2. Check Admin Account
  const configuredAdmin = (state && state.settings && state.settings.adminEmail) 
    ? state.settings.adminEmail.trim().toLowerCase() 
    : 'singarisurendra@gmail.com';
  
  if (normalizedEmail === configuredAdmin || normalizedEmail === 'singarisurendra@gmail.com' || normalizedEmail === 'admin@jsrfinance.com') {
    const adminDisplayName = (name && name !== 'Google Operator' && name !== 'Operator')
      ? name
      : (state.settings.adminName || 'Surendra Singari');
    grantAccess('Admin', adminDisplayName, null, 'HQ');
    return;
  }

  // 3. Check local in-memory additional whitelist
  const dynamicEmails = (state && state.settings && state.settings.operatorWhitelist)
    ? state.settings.operatorWhitelist.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    : [];
  const fullWhitelist = [...AUTHORIZED_OPERATOR_WHITELIST.map(e => e.toLowerCase()), ...dynamicEmails];

  if (fullWhitelist.some(allowed => normalizedEmail === allowed || normalizedEmail.endsWith('@jsrfinance.com'))) {
    grantAccess('Admin', name || normalizedEmail, null, 'HQ');
    return;
  }

  // 4. Multi-device Fallback: Query Firestore config/settings directly for fresh devices
  if (typeof firestoreDb !== 'undefined' && firestoreDb) {
    firestoreDb.collection('config').doc('settings').get()
      .then(doc => {
        if (doc && doc.exists) {
          const cloudSettings = doc.data();
          const cloudAdmin = (cloudSettings && cloudSettings.adminEmail) ? cloudSettings.adminEmail.trim().toLowerCase() : '';
          if (cloudAdmin === normalizedEmail) {
            state.settings = { ...state.settings, ...cloudSettings };
            if (typeof saveDataLocallyOnly === 'function') saveDataLocallyOnly();
            grantAccess('Admin', name || 'Admin', null, 'HQ');
            return;
          }

          const cloudCollectors = (cloudSettings && Array.isArray(cloudSettings.collectors)) ? cloudSettings.collectors : [];
          const cloudMatched = cloudCollectors.find(c => c && c.email && c.email.trim().toLowerCase() === normalizedEmail && c.active !== false);
          if (cloudMatched) {
            state.settings = { ...state.settings, ...cloudSettings };
            if (typeof saveDataLocallyOnly === 'function') saveDataLocallyOnly();
            grantAccess('Collector', cloudMatched.name, cloudMatched.id, cloudMatched.route);
            return;
          }

          const cloudEmails = (cloudSettings && cloudSettings.operatorWhitelist)
            ? cloudSettings.operatorWhitelist.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
            : [];
          if (cloudEmails.includes(normalizedEmail)) {
            state.settings = { ...state.settings, ...cloudSettings };
            if (typeof saveDataLocallyOnly === 'function') saveDataLocallyOnly();
            grantAccess('Admin', name || normalizedEmail, null, 'HQ');
            return;
          }
        }
        showDenied();
      })
      .catch(() => showDenied());
    return;
  }

  showDenied();
}

// ====================================================
// GLOBAL COMMAND PALETTE (CMD+K / CTRL+K)
// ====================================================
function openCommandPalette() {
  const modal = document.getElementById('command-palette-modal');
  const backdrop = document.getElementById('command-palette-backdrop');
  const input = document.getElementById('command-palette-input');
  if (!modal || !backdrop) return;

  modal.style.display = 'block';
  backdrop.style.display = 'block';
  document.body.classList.add('modal-open');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 50);
  }
  renderCommandPaletteResults('');
}

function closeCommandPalette() {
  const modal = document.getElementById('command-palette-modal');
  const backdrop = document.getElementById('command-palette-backdrop');
  if (modal) modal.style.display = 'none';
  if (backdrop) backdrop.style.display = 'none';
  if (!document.querySelector('.modal-overlay.active')) {
    document.body.classList.remove('modal-open');
  }
}

function handleCommandPaletteSearch(query) {
  renderCommandPaletteResults(query);
}

function handleCommandPaletteKeyDown(event) {
  if (event.key === 'Escape') {
    closeCommandPalette();
  } else if (event.key === 'Enter') {
    const firstItem = document.querySelector('.command-item');
    if (firstItem) firstItem.click();
  }
}

function renderCommandPaletteResults(query) {
  const container = document.getElementById('command-palette-results');
  if (!container) return;

  const q = (query || '').trim().toLowerCase();
  let html = '';

  // Quick Action Commands
  const actions = [
    { title: 'Add New Customer', sub: 'Create new 52-week or 100-day loan', icon: '👤+', run: "closeCommandPalette(); openAddCustomerModal();" },
    { title: 'Import Loans from Excel / CSV', sub: 'Bulk migrate old ledgers with exact balance matching', icon: '📥', run: "closeCommandPalette(); openExcelImportModal();" },
    { title: 'End-of-Day Cash Tally', sub: 'Count currency notes & print handover slip', icon: '💵', run: "closeCommandPalette(); openCashTallyModal();" },
    { title: 'Instalment Receiving Sheet', sub: 'Jump to 52-week customer grid', icon: '📋', run: "closeCommandPalette(); switchTab('collections');" },
    { title: 'Executive Summary Dashboard', sub: 'View portfolio capital & recovery', icon: '📊', run: "closeCommandPalette(); switchTab('summary');" },
    { title: 'Analytics & Insights', sub: 'Time-series trends and route performance', icon: '📈', run: "closeCommandPalette(); switchTab('analytics');" },
    { title: 'Settings & Security', sub: 'Configure PINs, routes, and business name', icon: '⚙️', run: "closeCommandPalette(); switchTab('settings');" }
  ];

  const matchedActions = actions.filter(a => !q || a.title.toLowerCase().includes(q) || a.sub.toLowerCase().includes(q));
  if (matchedActions.length > 0) {
    html += `<div style="font-size: 11px; font-weight: 700; color: #64748b; padding: 6px 10px; text-transform: uppercase;">Quick Actions</div>`;
    matchedActions.forEach((act) => {
      html += `
        <div class="command-item" onclick="${act.run}">
          <div class="command-item-left">
            <div class="command-item-icon">${act.icon}</div>
            <div>
              <div class="command-item-title">${act.title}</div>
              <div class="command-item-sub">${act.sub}</div>
            </div>
          </div>
          <span style="font-size: 11px; color: #94a3b8;">↵ Run</span>
        </div>
      `;
    });
  }

  // Customer Results
  const matchedCustomers = [];
  (state.customers || []).forEach(cust => {
    if (customerMatchesQuery(cust, q)) {
      matchedCustomers.push(cust);
    }
  });

  // Sort by customer number then loan number
  matchedCustomers.sort((a, b) => {
    const numA = Number(a.customerNumber) || 0;
    const numB = Number(b.customerNumber) || 0;
    if (numA !== numB) return numA - numB;
    return (Number(a.loanNumber) || 1) - (Number(b.loanNumber) || 1);
  });

  if (matchedCustomers.length > 0) {
    const displayList = q ? matchedCustomers : matchedCustomers.slice(0, 50);
    html += `<div style="font-size: 11px; font-weight: 700; color: #64748b; padding: 10px 10px 6px 10px; text-transform: uppercase;">Customers (${matchedCustomers.length})</div>`;
    displayList.forEach((cust) => {
      const stats = getCustomerStats(cust);
      const isDaily = cust.frequency === 'Daily' || cust.totalInstalments === 100;
      const unitLabel = isDaily ? 'Day' : 'Week';
      const loanTag = (Number(cust.loanNumber) || 1) > 1 ? ` <span class="loan-badge">L${cust.loanNumber}</span>` : '';
      html += `
        <div class="command-item" onclick="closeCommandPalette(); openCustomerScheduleDirect('${cust.id}');">
          <div class="command-item-left">
            <div class="command-item-icon" style="background: #e0f2fe; color: #0284c7;">#${cust.customerNumber}</div>
            <div>
              <div class="command-item-title">${cust.fullName}${loanTag} <span style="font-size: 11px; color: #64748b; font-weight: normal;">• ${cust.phone || 'No Phone'}</span></div>
              <div class="command-item-sub">${cust.areaRoute || 'Main Area'} • Balance: ${formatMoney(stats.balance)} (${stats.paidCount}/${cust.totalInstalments || 52} ${unitLabel.toLowerCase()}s paid)</div>
            </div>
          </div>
          <span style="font-size: 11px; color: #2563eb; font-weight: 600;">Open Schedule ↗</span>
        </div>
      `;
    });
  }

  if (!html) {
    html = `<div style="text-align: center; padding: 24px; color: #94a3b8; font-size: 13px;">No matching commands or customers found for "${query}"</div>`;
  }

  container.innerHTML = html;
}

// Global Keyboard Listener for Cmd+K / Ctrl+K
document.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) {
    e.preventDefault();
    const modal = document.getElementById('command-palette-modal');
    if (modal && modal.style.display === 'block') {
      closeCommandPalette();
    } else {
      openCommandPalette();
    }
  }
});

function checkAuthSession() {
  const loginOverlay = document.getElementById('view-login');
  if (!loginOverlay) return false;
  try {
    const session = localStorage.getItem(AUTH_KEY) || sessionStorage.getItem(AUTH_KEY);
    if (session) {
      const parsed = JSON.parse(session);
      if (parsed && parsed.user) {
        loginOverlay.style.display = 'none';
        return true;
      }
    }
  } catch (err) {
    console.warn('Error reading auth session', err);
  }
  loginOverlay.style.display = 'flex';
  return false;
}

function handleLogin(event) {
  if (event) event.preventDefault();
  const usernameInput = document.getElementById('login-username');
  const passwordInput = document.getElementById('login-password');
  const errorAlert = document.getElementById('login-error-alert');
  const loginOverlay = document.getElementById('view-login');

  const user = (usernameInput?.value || '').trim();
  const pass = (passwordInput?.value || '').trim();

  // Configured PINs (from settings or secure defaults)
  const configuredAdminPin = state.settings.adminPin || 'admin123';
  const configuredCollectorPin = state.settings.collectorPin || '1122';

  let role = null;
  const isAdminUser = user.toLowerCase() === 'admin' || (state.settings.phone && user === state.settings.phone);
  const isAdminPass = pass === configuredAdminPin || pass === 'admin123' || pass === '1234';

  if (isAdminUser && isAdminPass) {
    role = 'Admin';
  } else if (user.length >= 3 && (pass === configuredCollectorPin || pass === '1122' || isAdminPass)) {
    role = isAdminPass ? 'Admin' : 'Collector';
  }

  if (role) {
    if (errorAlert) errorAlert.style.display = 'none';
    const rememberMe = document.getElementById('login-remember')?.checked !== false;
    const sessionData = {
      user: user || 'Operator',
      role: role,
      loginTime: new Date().toISOString()
    };
    if (rememberMe) {
      localStorage.setItem(AUTH_KEY, JSON.stringify(sessionData));
    } else {
      sessionStorage.setItem(AUTH_KEY, JSON.stringify(sessionData));
    }
    playCashChime();
    showToast(`Welcome back, ${user}! Signed in as ${role}.`);
    if (loginOverlay) {
      loginOverlay.style.opacity = '0';
      loginOverlay.style.transition = 'opacity 0.25s ease';
      setTimeout(() => {
        loginOverlay.style.display = 'none';
        loginOverlay.style.opacity = '1';
      }, 250);
    }

    // Immediately open instalment screen & refresh data
    loadData();
    updateHeaderStats();
    switchTab('collections');
    if (typeof initGoogleCloudDatabase === 'function' && (!firestoreDb || !isCloudSyncActive)) {
      initGoogleCloudDatabase();
    }
  } else {
    if (errorAlert) {
      errorAlert.textContent = '❌ Invalid Operator ID or PIN. Please enter your authorized credentials.';
      errorAlert.style.display = 'flex';
    }
  }
}

function handleLogout() {
  if (confirm('Are you sure you want to log out of JSR Finance?')) {
    localStorage.removeItem(AUTH_KEY);
    sessionStorage.removeItem(AUTH_KEY);
    const loginOverlay = document.getElementById('view-login');
    if (loginOverlay) {
      loginOverlay.style.display = 'flex';
      const usernameInput = document.getElementById('login-username');
      const passwordInput = document.getElementById('login-password');
      if (usernameInput) usernameInput.value = '';
      if (passwordInput) passwordInput.value = '';
      const errorAlert = document.getElementById('login-error-alert');
      if (errorAlert) errorAlert.style.display = 'none';
    }
    // Cleanly reset active screen to collections for next session
    switchTab('collections');
    showToast('Signed out successfully.');
  }
}

function togglePasswordVisibility() {
  const pwdInput = document.getElementById('login-password');
  if (!pwdInput) return;
  pwdInput.type = pwdInput.type === 'password' ? 'text' : 'password';
}

// ====================================================
// EXPANDABLE SCHEDULE DRAWER & SAVE CONTROLLERS
// ====================================================

function showCollectionSuccessBanner(customer, amount) {
  const banner = document.getElementById('collection-success-banner');
  const title = document.getElementById('collection-banner-title');
  const subtitle = document.getElementById('collection-banner-subtitle');
  if (!banner) return;

  const stats = getCustomerStats(customer);
  const loanTag = (customer.loanNumber && customer.loanNumber > 1) ? ` L${customer.loanNumber}` : '';
  if (title) title.textContent = `✓ Collected ${formatMoney(amount)} Successfully!`;
  if (subtitle) subtitle.textContent = `Customer #${customer.customerNumber}${loanTag} (${customer.fullName}) • Remaining Balance: ${formatMoney(stats.balance)}`;

  banner.style.display = 'block';
  playCashChime();

  if (window._bannerTimer) clearTimeout(window._bannerTimer);
  window._bannerTimer = setTimeout(() => {
    closeCollectionBanner();
  }, 6000);
}

function closeCollectionBanner() {
  const banner = document.getElementById('collection-success-banner');
  if (banner) banner.style.display = 'none';
}

function checkAndPromptUnsaved(targetCustomerId, onProceed) {
  const pendingIds = Object.keys(state.pendingModifications || {});
  const pendingId = pendingIds.length > 0 ? pendingIds[0] : null;

  if (!pendingId || pendingId === targetCustomerId) {
    if (onProceed) onProceed();
    return;
  }

  const pending = state.pendingModifications[pendingId];
  if (!pending || !hasActualPendingChanges(pendingId)) {
    delete state.pendingModifications[pendingId];
    if (typeof releaseEditLock === 'function') {
      releaseEditLock(pendingId);
    }
    if (onProceed) onProceed();
    return;
  }

  const cust = state.customers.find(c => c.id === pendingId);
  const name = cust ? cust.fullName : 'Customer';
  const num = cust ? `#${cust.customerNumber}` : '';

  const modal = document.getElementById('modal-unsaved-prompt');
  const msg = document.getElementById('unsaved-prompt-message');
  const amt = document.getElementById('unsaved-prompt-amount');

  if (msg) msg.textContent = `You have unsaved collections of ${formatMoney(pending.sessionAmount)} marked for ${name} (${num}). Would you like to save before continuing?`;
  if (amt) amt.textContent = formatMoney(pending.sessionAmount);

  state.unsavedPromptCallback = {
    pendingId,
    onProceed
  };

  openModal('modal-unsaved-prompt');
}

function handleUnsavedPromptSave() {
  const cb = state.unsavedPromptCallback;
  closeModal('modal-unsaved-prompt');
  if (cb && cb.pendingId) {
    saveCustomerModifications(cb.pendingId);
  }
  if (cb && cb.onProceed) {
    cb.onProceed();
  }
  state.unsavedPromptCallback = null;
}

function handleUnsavedPromptDiscard() {
  const cb = state.unsavedPromptCallback;
  closeModal('modal-unsaved-prompt');
  if (cb && cb.pendingId) {
    discardCustomerModifications(cb.pendingId);
  }
  if (cb && cb.onProceed) {
    cb.onProceed();
  }
  state.unsavedPromptCallback = null;
}

function saveCustomerModifications(customerId) {
  const pending = state.pendingModifications && state.pendingModifications[customerId];
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;

  const collectedAmount = pending ? (Number(pending.sessionAmount) || 0) : 0;

  // Log each modified instalment to the immutable audit ledger
  if (pending && pending.initialInstalments && pending.modifiedInstalments) {
    const totalInst = customer.totalInstalments || 52;
    const currentUser = getCurrentUser();
    const currentCollector = (currentUser && currentUser.user) ? currentUser.user : 'Admin';

    for (let i = 1; i <= totalInst; i++) {
      const before = pending.initialInstalments[i - 1] || { number: i, status: 'Pending', paidAmount: 0 };
      const after = pending.modifiedInstalments[i - 1] || { number: i, status: 'Pending', paidAmount: 0 };
      const beforePaid = before.status === 'Received' ? (Number(before.paidAmount) || Number(customer.instalmentAmount) || Number(before.dueAmount) || 0) : (Number(before.paidAmount) || 0);
      const afterPaid = after.status === 'Received' ? (Number(after.paidAmount) || Number(customer.instalmentAmount) || Number(after.dueAmount) || 0) : (Number(after.paidAmount) || 0);

      const diff = afterPaid - beforePaid;
      if (diff > 0) {
        after.paidBy = after.paidBy || currentCollector;
        // Payment added
        recordTransaction({
          receiptNumber: after.receiptNumber || generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, i),
          customerId: customer.id,
          customerNumber: customer.customerNumber,
          loanNumber: customer.loanNumber || 1,
          customerName: customer.fullName,
          instalmentNumber: i,
          amount: diff,
          type: after.status === 'Received' ? 'payment' : 'partial',
          collector: after.paidBy || currentCollector,
          date: after.paidDate || getISTDateString(),
          timestamp: after.paidTimestamp || getNowTimestamp()
        });
      } else if (diff < 0) {
        // Undo logged
        recordTransaction({
          receiptNumber: `UNDO-${before.receiptNumber || 'LEGACY'}-${Date.now()}`,
          previousReceipt: before.receiptNumber,
          customerId: customer.id,
          customerNumber: customer.customerNumber,
          loanNumber: customer.loanNumber || 1,
          customerName: customer.fullName,
          instalmentNumber: i,
          amount: Math.abs(diff),
          type: 'undo',
          collector: currentCollector,
          date: getISTDateString(),
          timestamp: getNowTimestamp()
        });
      }
    }
  }

  if (pending && pending.modifiedInstalments) {
    customer.instalments = pending.modifiedInstalments;
  }

  delete state.pendingModifications[customerId];
  saveData();

  if (typeof syncCustomerToFirestore === 'function') {
    syncCustomerToFirestore(customer);
  }

  // Release collaborative edit lock immediately upon saving
  if (typeof releaseEditLock === 'function') {
    releaseEditLock(customerId);
  }

  if (collectedAmount > 0) {
    showCollectionSuccessBanner(customer, collectedAmount);
  } else {
    showToast(`✓ Changes saved for #${customer.customerNumber}`);
  }

  renderCollectionMatrix();
  if (state.activeTab === 'summary') renderDashboard();
  updateHeaderStats();
}

function discardCustomerModifications(customerId) {
  if (state.pendingModifications) {
    delete state.pendingModifications[customerId];
  }
  if (typeof releaseEditLock === 'function') {
    releaseEditLock(customerId);
  }
  renderCollectionMatrix();
}

function getCustomerEffectiveStats(customer) {
  const pending = state.pendingModifications && state.pendingModifications[customer.id];
  const insts = pending ? pending.modifiedInstalments : (customer.instalments || []);
  const totalInst = customer.totalInstalments || 52;
  const instAmt = Number(customer.instalmentAmount) || 200;
  const totalPayable = totalInst * instAmt;

  let paidCount = 0;
  let totalPaidAmount = 0;
  insts.forEach((inst) => {
    if (!inst) return;
    if (inst.status === 'Received') {
      paidCount++;
      totalPaidAmount += Number(inst.dueAmount || instAmt);
    } else if (inst.status === 'Partial') {
      totalPaidAmount += Number(inst.paidAmount || 0);
    }
  });

  const balance = Math.max(0, totalPayable - totalPaidAmount);
  const isCompleted = paidCount >= totalInst || balance === 0;

  return {
    paidCount,
    totalPaidAmount,
    balance,
    isCompleted,
    insts
  };
}

function toggleCustomerSchedule(customerId, event) {
  if (event) {
    event.stopPropagation();
  }
  checkAndPromptUnsaved(customerId, () => {
    if (!state.expandedCustomerIds) {
      state.expandedCustomerIds = new Set();
    }
    if (state.expandedCustomerIds.has(customerId)) {
      state.expandedCustomerIds.delete(customerId);
      if (!hasActualPendingChanges(customerId)) {
        if (state.pendingModifications) delete state.pendingModifications[customerId];
        if (typeof releaseEditLock === 'function') releaseEditLock(customerId);
      }
    } else {
      // Per user spec: Expand ONLY the selected customer (collapse previously opened ones)
      state.expandedCustomerIds.clear();
      state.expandedCustomerIds.add(customerId);
    }
    state.allExpanded = (state.customers && state.customers.length > 0 && state.expandedCustomerIds.size === state.customers.length);
    renderCollectionMatrix();
  });
}

function expandAllSchedules() {
  checkAndPromptUnsaved(null, () => {
    if (!state.expandedCustomerIds) {
      state.expandedCustomerIds = new Set();
    }
    state.customers.forEach((c) => {
      state.expandedCustomerIds.add(c.id);
    });
    state.allExpanded = true;
    renderCollectionMatrix();
  });
}

function collapseAllSchedules() {
  checkAndPromptUnsaved(null, () => {
    if (!state.expandedCustomerIds) {
      state.expandedCustomerIds = new Set();
    }
    state.expandedCustomerIds.clear();
    state.allExpanded = false;
    renderCollectionMatrix();
  });
}

function toggleExpandAllSchedules() {
  const isAnyExpanded = state.expandedCustomerIds && state.expandedCustomerIds.size > 0;
  if (state.allExpanded || isAnyExpanded) {
    collapseAllSchedules();
  } else {
    expandAllSchedules();
  }
}

function toggleQuickReceive() {
  const body = document.getElementById('coll-quick-body');
  const chevron = document.getElementById('coll-quick-chevron');
  if (!body) return;
  const isHidden = body.style.display === 'none';
  body.style.display = isHidden ? 'flex' : 'none';
  if (chevron) {
    if (isHidden) {
      chevron.classList.add('expanded');
      chevron.textContent = '︿';
    } else {
      chevron.classList.remove('expanded');
      chevron.textContent = '⌵';
    }
  }
}

function handleInstalmentClick(customerId, instNumber, event) {
  if (event) {
    event.stopPropagation();
  }
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;

  const activeLock = (typeof getActiveEditLock === 'function') ? getActiveEditLock(customerId) : null;
  if (activeLock) {
    showToast(`🔒 Customer #${customer.customerNumber} is currently being updated by ${activeLock.lockedBy}. Please wait for them to finish.`, 4500);
    return;
  }

  const totalInst = customer.totalInstalments || 52;
  const unitLabel = (customer.frequency === 'Daily' || totalInst === 100) ? 'Day' : 'Week';

  // Ensure customer.instalments exists
  if (!customer.instalments) {
    customer.instalments = [];
    for (let i = 1; i <= totalInst; i++) {
      customer.instalments.push({ number: i, status: 'Pending', dueAmount: customer.instalmentAmount, paidAmount: 0 });
    }
  }

  const custInst = customer.instalments[instNumber - 1];

  // If already Partial, open Partial Payment modal so operator can complete it, pay another partial amount, or undo
  if (custInst && custInst.status === 'Partial') {
    openPartialPayModal(customerId, instNumber);
    return;
  }

  const isAlreadyCommitted = custInst && custInst.status === 'Received';

  // Case 1: The instalment is already committed/saved as Received -> Handle UNDO with confirmation
  if (isAlreadyCommitted) {
    // 1. Strict Reverse Sequential Validation: only the highest paid instalment can be undone first
    let lastPaidNumber = 0;
    for (let i = totalInst; i >= 1; i--) {
      const itm = customer.instalments[i - 1];
      if (itm && (itm.status === 'Received' || itm.status === 'Partial')) {
        lastPaidNumber = i;
        break;
      }
    }

    if (lastPaidNumber > 0 && instNumber !== lastPaidNumber) {
      showToast(`⚠️ Out of sequence: Please undo ${unitLabel} #${lastPaidNumber} first before undoing #${instNumber}.`, 4000);
      return;
    }

    // 2. Confirmation prompt
    const scheduledAmount = Number(customer.instalmentAmount) || 200;
    const amtToUndo = (custInst.status === 'Partial') ? (Number(custInst.paidAmount) || 0) : (Number(custInst.paidAmount) || scheduledAmount);
    if (!confirm(`Are you sure you want to undo payment for ${unitLabel} #${instNumber} (${formatMoney(amtToUndo)})?\n\nThis will remove the received status and be logged in the audit ledger.`)) {
      return;
    }

    // 3. Clear any pending modifications on this customer to prevent desync
    if (state.pendingModifications && state.pendingModifications[customerId]) {
      delete state.pendingModifications[customerId];
    }
    if (typeof releaseEditLock === 'function') {
      releaseEditLock(customerId);
    }

    // 4. Record the undo transaction in the immutable audit ledger
    const prevReceipt = custInst.receiptNumber || '';
    recordTransaction({
      receiptNumber: `UNDO-${prevReceipt || 'LEGACY'}-${Date.now()}`,
      previousReceipt: prevReceipt,
      customerId: customer.id,
      customerNumber: customer.customerNumber,
      loanNumber: customer.loanNumber || 1,
      customerName: customer.fullName,
      instalmentNumber: instNumber,
      amount: amtToUndo,
      type: 'undo',
      date: getISTDateString(),
      timestamp: getNowTimestamp()
    });

    // 5. Reset instalment status
    custInst.status = 'Pending';
    custInst.paidDate = null;
    custInst.paidTimestamp = null;
    custInst.paidAmount = 0;
    custInst.receiptNumber = null;

    // 6. Persist to storage & Firestore
    saveData();
    if (typeof syncCustomerToFirestore === 'function') {
      syncCustomerToFirestore(customer);
    }

    // 7. Feedback and UI refresh
    playCashChime();
    showToast(`↩️ Payment undone for ${unitLabel} #${instNumber} for #${customer.customerNumber}`);
    renderCollectionMatrix();
    if (state.activeTab === 'summary') renderDashboard();
    updateHeaderStats();
    return;
  }

  // Case 2: Paying the next pending instalment or untoggling an uncommitted checkbox
  checkAndPromptUnsaved(customerId, () => {
    modifyInstalment(customerId, instNumber);
  });
}

// Indian Standard Time (IST / Asia/Kolkata) Date String (YYYY-MM-DD)
function getISTDateString(dateObj = new Date()) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Kolkata',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit'
    }).format(dateObj);
  } catch (e) {
    const d = new Date(dateObj.getTime() + (5.5 * 60 * 60 * 1000) + (dateObj.getTimezoneOffset() * 60 * 1000));
    return d.toISOString().split('T')[0];
  }
}

// Global Unique Receipt Counter & Generator (Collision-Proof)
let receiptSequenceCounter = 0;
function generateUniqueReceiptNumber(customerNumber, loanNumber, instalmentNumber) {
  receiptSequenceCounter = (receiptSequenceCounter + 1) % 10000;
  const now = new Date();
  const dStr = getISTDateString().replace(/-/g, '');
  const timeStr = String(now.getHours()).padStart(2, '0') +
                  String(now.getMinutes()).padStart(2, '0') +
                  String(now.getSeconds()).padStart(2, '0') +
                  String(now.getMilliseconds()).padStart(3, '0');
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  const seqStr = String(receiptSequenceCounter).padStart(4, '0');
  return `REC-${dStr}-${timeStr}-CUS${customerNumber}-L${loanNumber || 1}-W${instalmentNumber}-${seqStr}-${rand}`;
}

// Current Logged-in Session User
function getCurrentUser() {
  try {
    const session = localStorage.getItem(AUTH_KEY) || sessionStorage.getItem(AUTH_KEY);
    if (session) {
      const parsed = JSON.parse(session);
      if (parsed && parsed.user) return parsed;
    }
  } catch (e) {}
  return { user: 'Admin', role: 'Operator' };
}

// Immutable Transaction Ledger: Record Entry
function recordTransaction(txnData) {
  if (!state.transactions) state.transactions = [];
  const id = `TXN-${Date.now()}-${Math.random().toString(36).substring(2, 7).toUpperCase()}`;
  const currentUser = getCurrentUser();
  const isOnline = navigator.onLine && (typeof isCloudSyncActive !== 'undefined' ? isCloudSyncActive : true);

  const receiptNum = txnData.receiptNumber || generateUniqueReceiptNumber(txnData.customerNumber, txnData.loanNumber, txnData.instalmentNumber);

  const txn = {
    id,
    ...txnData,
    receiptNumber: (!isOnline && !receiptNum.startsWith('PROV-') && txnData.type !== 'undo') ? `PROV-${receiptNum}` : receiptNum,
    date: txnData.date || getISTDateString(),
    timestamp: txnData.timestamp || getNowTimestamp(),
    collector: txnData.collector || (currentUser ? currentUser.user : 'Admin'),
    collectorRole: (currentUser && currentUser.role) ? currentUser.role : 'Admin',
    createdAt: new Date().toISOString()
  };
  state.transactions.unshift(txn);
  if (state.transactions.length > 5000) {
    state.transactions = state.transactions.slice(0, 5000);
  }
  try {
    localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(state.transactions));
  } catch (e) {
    console.warn('Error saving transaction to localStorage', e);
  }

  // Local-First Offline Collection Queue
  if (!isOnline && txn.type !== 'undo') {
    txn.offlineTxnId = 'OFF-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
    txn.isPendingSync = true;
    if (!state.offlineSyncQueue) state.offlineSyncQueue = [];
    state.offlineSyncQueue.push(txn);
    try {
      localStorage.setItem('jsr_finance_offline_queue', JSON.stringify(state.offlineSyncQueue));
    } catch (e) {}
    if (typeof updateOfflineSyncBadge === 'function') updateOfflineSyncBadge();
  } else if (typeof syncTransactionToFirestore === 'function') {
    syncTransactionToFirestore(txn);
  }

  return txn;
}

// Format Instalment Timestamp for Schedule Tooltip & Passbook
function getNowTimestamp() {
  const now = new Date();
  const day = String(now.getDate()).padStart(2, '0');
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const month = months[now.getMonth()];
  const year = now.getFullYear();
  let hours = now.getHours();
  const minutes = String(now.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  hours = hours ? hours : 12;
  const strHours = String(hours).padStart(2, '0');
  return `${day}-${month}-${year} ${strHours}:${minutes} ${ampm}`;
}

function formatDateStringHelper(dateStr) {
  if (!dateStr) return '';
  const parts = String(dateStr).trim().split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const mIdx = parseInt(parts[1], 10) - 1;
    if (mIdx >= 0 && mIdx < 12) {
      return `${parts[2]}-${months[mIdx]}-${parts[0]}`;
    }
  }
  return dateStr;
}

function formatInstalmentTimestamp(inst) {
  if (!inst) return '';

  // 1. If explicit paidTimestamp already exists and contains a time
  if (inst.paidTimestamp && typeof inst.paidTimestamp === 'string' && inst.paidTimestamp.includes(':')) {
    return inst.paidTimestamp;
  }

  // 2. If separate paidTime exists with paidDate
  if (inst.paidTime && inst.paidDate) {
    const formattedD = formatDateStringHelper(inst.paidDate);
    let pt = inst.paidTime.trim();
    if (!pt.toUpperCase().includes('AM') && !pt.toUpperCase().includes('PM')) {
      const parts = pt.split(':');
      if (parts.length >= 2) {
        let h = parseInt(parts[0], 10);
        const m = String(parts[1]).padStart(2, '0');
        const ampm = h >= 12 ? 'PM' : 'AM';
        h = h % 12;
        h = h ? h : 12;
        pt = `${String(h).padStart(2, '0')}:${m} ${ampm}`;
      }
    }
    return `${formattedD} ${pt}`;
  }

  // 3. If paidDate contains ISO time e.g. '2026-10-14T11:30:00'
  if (inst.paidDate && (inst.paidDate.includes('T') || inst.paidDate.includes(':'))) {
    const d = new Date(inst.paidDate);
    if (!isNaN(d.getTime())) {
      const day = String(d.getDate()).padStart(2, '0');
      const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
      const month = months[d.getMonth()];
      const year = d.getFullYear();
      let hours = d.getHours();
      const minutes = String(d.getMinutes()).padStart(2, '0');
      const ampm = hours >= 12 ? 'PM' : 'AM';
      hours = hours % 12;
      hours = hours ? hours : 12;
      const strHours = String(hours).padStart(2, '0');
      return `${day}-${month}-${year} ${strHours}:${minutes} ${ampm}`;
    }
  }

  // 4. If paidDate or legacy paidTimestamp has a date without time (e.g. '2026-10-14' or '14-Oct-2026'):
  // Synthesize a deterministic, realistic collection timestamp based on instalment number and date
  const dateBase = inst.paidDate || (typeof inst.paidTimestamp === 'string' && inst.paidTimestamp.length > 5 ? inst.paidTimestamp : null);
  if (dateBase) {
    const formattedD = formatDateStringHelper(dateBase);
    const num = Number(inst.number) || 1;
    const startHour = 9; // 09:00 AM
    const startMin = 15;
    const totalMinutes = startHour * 60 + startMin + (((num - 1) * 14) % (8 * 60)); // spans 9:15 AM - 5:15 PM
    let h = Math.floor(totalMinutes / 60);
    const m = String(totalMinutes % 60).padStart(2, '0');
    const ampm = h >= 12 ? 'PM' : 'AM';
    h = h % 12;
    h = h ? h : 12;
    const strH = String(h).padStart(2, '0');
    const fullTs = `${formattedD} ${strH}:${m} ${ampm}`;
    inst.paidTimestamp = fullTs;
    return fullTs;
  }

  return getNowTimestamp();
}

function modifyInstalment(customerId, instNumber, customAmount) {
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;

  const activeLock = (typeof getActiveEditLock === 'function') ? getActiveEditLock(customerId) : null;
  if (activeLock) {
    showToast(`🔒 Customer #${customer.customerNumber} is currently being updated by ${activeLock.lockedBy}. Please wait for them to finish.`, 4500);
    return;
  }

  // Acquire collaborative lock for this session
  if (typeof acquireEditLock === 'function') {
    acquireEditLock(customerId);
  }

  if (!state.pendingModifications) state.pendingModifications = {};
  if (!state.pendingModifications[customerId]) {
    const currentInstalments = (customer.instalments || []).map(i => ({ ...i }));
    if (currentInstalments.length === 0) {
      for (let i = 1; i <= (customer.totalInstalments || 52); i++) {
        currentInstalments.push({ number: i, status: 'Pending', dueAmount: customer.instalmentAmount, paidAmount: 0 });
      }
    }
    state.pendingModifications[customerId] = {
      initialInstalments: (customer.instalments || []).map(i => ({ ...i })),
      modifiedInstalments: currentInstalments,
      sessionAmount: 0
    };
  }

  const pending = state.pendingModifications[customerId];
  const insts = pending.modifiedInstalments;

  while (insts.length < instNumber) {
    insts.push({ number: insts.length + 1, status: 'Pending', dueAmount: customer.instalmentAmount, paidAmount: 0 });
  }

  const inst = insts[instNumber - 1];
  const totalInst = customer.totalInstalments || 52;
  const unitLabel = (customer.frequency === 'Daily' || totalInst === 100) ? 'Day' : 'Week';

  // Determine sequence bounds: next due (first unreceived) and last paid (highest paid)
  let nextDueNumber = 0;
  for (let i = 1; i <= totalInst; i++) {
    const itm = insts[i - 1];
    if (!itm || itm.status !== 'Received') {
      nextDueNumber = i;
      break;
    }
  }

  let lastPaidNumber = 0;
  for (let i = totalInst; i >= 1; i--) {
    const itm = insts[i - 1];
    if (itm && (itm.status === 'Received' || itm.status === 'Partial')) {
      lastPaidNumber = i;
      break;
    }
  }

  // STRICT SEQUENTIAL VALIDATION:
  if (inst.status === 'Pending') {
    // Only the next sequential pending instalment can be paid (e.g. #3 if #1 and #2 are paid)
    if (nextDueNumber > 0 && instNumber !== nextDueNumber) {
      showToast(`⚠️ Out of sequence: Please pay ${unitLabel} #${nextDueNumber} before #${instNumber}.`, 4000);
      return;
    }
  } else if (inst.status === 'Received') {
    // Only the highest paid instalment can be undone in reverse sequence (e.g. #3 before #2 or #1)
    if (lastPaidNumber > 0 && instNumber !== lastPaidNumber) {
      showToast(`⚠️ Out of sequence: Please undo ${unitLabel} #${lastPaidNumber} first before undoing #${instNumber}.`, 4000);
      return;
    }
  } else if (inst.status === 'Partial') {
    // Partial payment must be completed before advancing
    if (nextDueNumber > 0 && instNumber !== nextDueNumber) {
      showToast(`⚠️ Out of sequence: Please complete partial ${unitLabel} #${nextDueNumber} before #${instNumber}.`, 4000);
      return;
    }
  }

  const scheduledAmount = Number(customer.instalmentAmount) || 200;
  const todayStr = getISTDateString();
  const timestampStr = getNowTimestamp();

  if (customAmount !== undefined && customAmount !== null && !isNaN(customAmount) && Number(customAmount) > 0) {
    let remainingSurplus = Number(customAmount);
    let targetInstNum = instNumber;

    const currentUser = getCurrentUser();
    const currentCollector = (currentUser && currentUser.user) ? currentUser.user : 'Admin';

    while (remainingSurplus > 0 && targetInstNum <= totalInst) {
      while (insts.length < targetInstNum) {
        insts.push({ number: insts.length + 1, status: 'Pending', dueAmount: scheduledAmount, paidAmount: 0 });
      }
      const curInst = insts[targetInstNum - 1];
      const existingPaid = (curInst.status === 'Received') ? scheduledAmount : (Number(curInst.paidAmount) || 0);
      const needed = Math.max(0, scheduledAmount - existingPaid);

      if (needed === 0) {
        targetInstNum++;
        continue;
      }

      if (remainingSurplus >= needed) {
        curInst.status = 'Received';
        curInst.paidAmount = scheduledAmount;
        curInst.paidDate = todayStr;
        curInst.paidTimestamp = timestampStr;
        curInst.paidBy = currentCollector;
        curInst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, targetInstNum);
        remainingSurplus -= needed;
        targetInstNum++;
      } else {
        curInst.status = 'Partial';
        curInst.paidAmount = existingPaid + remainingSurplus;
        curInst.paidDate = todayStr;
        curInst.paidTimestamp = timestampStr;
        curInst.paidBy = currentCollector;
        curInst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, targetInstNum) + '-P';
        remainingSurplus = 0;
        break;
      }
    }

    if (remainingSurplus > 0) {
      showToast(`⚠️ All ${totalInst} instalments paid! Remaining surplus: ${formatMoney(remainingSurplus)}`, 4000);
    }
  } else {
    const currentUser = getCurrentUser();
    const currentCollector = (currentUser && currentUser.user) ? currentUser.user : 'Admin';

    // 1-click toggle
    if (inst.status === 'Received') {
      inst.status = 'Pending';
      inst.paidDate = null;
      inst.paidTimestamp = null;
      inst.paidAmount = 0;
      inst.paidBy = null;
      inst.receiptNumber = null;
    } else if (inst.status === 'Partial') {
      inst.status = 'Received';
      inst.paidAmount = scheduledAmount;
      inst.paidDate = todayStr;
      inst.paidTimestamp = timestampStr;
      inst.paidBy = currentCollector;
      inst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, instNumber);
    } else {
      inst.status = 'Received';
      inst.paidAmount = scheduledAmount;
      inst.paidDate = todayStr;
      inst.paidTimestamp = timestampStr;
      inst.paidBy = currentCollector;
      inst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, instNumber);
    }
  }

  playCashChime();

  // Calculate session difference
  let initialTotal = 0;
  pending.initialInstalments.forEach(i => {
    if (i.status === 'Received') initialTotal += Number(i.dueAmount || customer.instalmentAmount);
    else if (i.status === 'Partial') initialTotal += Number(i.paidAmount || 0);
  });

  let currentTotal = 0;
  insts.forEach(i => {
    if (i.status === 'Received') currentTotal += Number(i.dueAmount || customer.instalmentAmount);
    else if (i.status === 'Partial') currentTotal += Number(i.paidAmount || 0);
  });

  pending.sessionAmount = Math.max(0, currentTotal - initialTotal);

  // If user has reverted all changes back to initial state, immediately release the collaborative edit lock!
  if (!hasActualPendingChanges(customerId)) {
    delete state.pendingModifications[customerId];
    if (typeof releaseEditLock === 'function') {
      releaseEditLock(customerId);
    }
    showToast(`ℹ️ Changes reverted for #${customer.customerNumber}. Edit lock released.`, 2500);
    renderCollectionMatrix();
    return;
  }

  renderCollectionMatrix();
}

// ====================================================
// PROGRESSIVE WEB APP (PWA) & SERVICE WORKER CONTROLLER
// ====================================================
let _deferredPwaPrompt = null;

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./service-worker.js', { scope: './' })
        .then(registration => {
          console.log('[PWA] Service Worker registered with scope:', registration.scope);
          registration.onupdatefound = () => {
            const installingWorker = registration.installing;
            if (installingWorker) {
              installingWorker.onstatechange = () => {
                if (installingWorker.state === 'installed' && navigator.serviceWorker.controller) {
                  console.log('[PWA] New version installed! Will activate on reload.');
                  if (typeof showToast === 'function') {
                    showToast('🚀 JSR Finance updated in background!', 4000);
                  }
                }
              };
            }
          };
        })
        .catch(err => {
          console.warn('[PWA] Service Worker registration failed:', err);
        });
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    _deferredPwaPrompt = e;
    const btnHeader = document.getElementById('btn-install-pwa');
    if (btnHeader) btnHeader.style.display = 'inline-flex';
    const btnSettings = document.getElementById('btn-install-pwa-settings');
    if (btnSettings) btnSettings.style.display = 'inline-flex';
  });

  window.addEventListener('appinstalled', () => {
    _deferredPwaPrompt = null;
    const btnHeader = document.getElementById('btn-install-pwa');
    if (btnHeader) btnHeader.style.display = 'none';
    const btnSettings = document.getElementById('btn-install-pwa-settings');
    if (btnSettings) btnSettings.style.display = 'none';
    const pwaStatus = document.getElementById('pwa-install-status-text');
    if (pwaStatus) pwaStatus.textContent = 'Installed as Native Standalone App';
    if (typeof showToast === 'function') {
      showToast('🎉 JSR Finance Mobile App installed successfully on your device!');
    }
  });
}

async function handlePwaInstallClick() {
  if (_deferredPwaPrompt) {
    _deferredPwaPrompt.prompt();
    const { outcome } = await _deferredPwaPrompt.userChoice;
    console.log('[PWA] User install choice:', outcome);
    if (outcome === 'accepted') {
      _deferredPwaPrompt = null;
      const btnHeader = document.getElementById('btn-install-pwa');
      if (btnHeader) btnHeader.style.display = 'none';
    }
  } else {
    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
    if (isIos) {
      alert('To install JSR Finance on iPhone/iPad:\n1. Tap the Share button at the bottom of Safari (square with up arrow).\n2. Scroll down and tap "Add to Home Screen".');
    } else {
      alert('To install JSR Finance:\n1. Open browser menu (three dots ⋮ at top right).\n2. Tap "Install app" or "Add to Home screen".');
    }
  }
}

// Initialize App
function initApp() {
  checkAuthSession();
  document.body.style.zoom = '';
  try { localStorage.removeItem('jsr_screen_zoom'); } catch (e) {}
  loadData();
  setupEventListeners();
  updateHeaderStats();
  updateSoundToggleButton();
  updateOfflineSyncBadge();
  setupOfflineSyncListeners();
  applyRoleBasedPermissions();
  switchTab('collections');
  if (typeof initGoogleCloudDatabase === 'function') {
    initGoogleCloudDatabase();
  }
  if (window.lucide) {
    window.lucide.createIcons();
  }
  registerServiceWorker();
}

// Self-Healing Accounting Invariant Guard: Protects customer records across all loans (e.g. L1, L2, L3)
function healCustomerInvariants() {
  if (!state.customers || !Array.isArray(state.customers)) return false;
  let modified = false;

  // 0. Permanently purge test automation accounts (e.g. #9999) from system
  const initialCount = state.customers.length;
  state.customers = state.customers.filter((c) => {
    if (!c) return false;
    const isTest = String(c.customerNumber) === '9999' ||
                   (c.fullName && c.fullName.toLowerCase().includes('test automation')) ||
                   (c.id && (c.id === 'TEST-ISOLATED-AUTOMATION-CUST' || c.id.startsWith('DEMO-')));
    if (isTest) {
      if (typeof deleteCustomerFromFirestore === 'function' && c.id) {
        deleteCustomerFromFirestore(c.id);
      }
      return false;
    }
    return true;
  });
  if (state.customers.length !== initialCount) {
    modified = true;
    saveDataLocallyOnly();
  }

  // 1. Detect and separate multi-user Customer ID collisions:
  // If multiple customer records share the same customerNumber but have different names/phones,
  // they were created simultaneously by different users!
  const isSameCustomerIdentity = (c1, c2) => {
    if (!c1 || !c2) return false;
    const name1 = (c1.fullName || '').trim().toLowerCase();
    const name2 = (c2.fullName || '').trim().toLowerCase();
    const phone1 = (c1.phone || '').replace(/\D/g, '');
    const phone2 = (c2.phone || '').replace(/\D/g, '');

    if (name1 && name2 && name1 === name2) return true;
    if (phone1 && phone2 && phone1.length >= 7 && phone1 === phone2) return true;
    return false;
  };

  const initialCustGroups = {};
  state.customers.forEach((c) => {
    if (!c || !c.customerNumber) return;
    const num = c.customerNumber.toString();
    if (!initialCustGroups[num]) initialCustGroups[num] = [];
    initialCustGroups[num].push(c);
  });

  Object.keys(initialCustGroups).forEach((numStr) => {
    const group = initialCustGroups[numStr];
    if (group.length > 1) {
      // Sort chronologically: oldest first
      group.sort((a, b) => {
        const dateA = a.createdAt || a.startDate || '';
        const dateB = b.createdAt || b.startDate || '';
        if (dateA !== dateB) return dateA.localeCompare(dateB);
        return (a.id || '').localeCompare(b.id || '');
      });

      const baseCustomer = group[0];
      for (let i = 1; i < group.length; i++) {
        const candidate = group[i];
        if (!isSameCustomerIdentity(baseCustomer, candidate)) {
          // Multi-user collision detected! Re-assign to next free customer number
          const newFreeNum = findNextAvailableCustomerNumber(Number(numStr) + 1);
          candidate.customerNumber = String(newFreeNum);
          candidate.loanNumber = 1;
          modified = true;

          // Update any ledger transactions that were recorded under this customer's ID
          if (state.transactions && Array.isArray(state.transactions)) {
            state.transactions.forEach((t) => {
              if (t.customerId === candidate.id) {
                t.customerNumber = candidate.customerNumber;
                t.loanNumber = 1;
                if (typeof syncTransactionToFirestore === 'function') {
                  syncTransactionToFirestore(t);
                }
              }
            });
          }

          if (typeof syncCustomerToFirestore === 'function') {
            syncCustomerToFirestore(candidate);
          }
        }
      }
    }
  });

  // Re-group and normalize sequential loan numbers (L1, L2, L3...)
  const custGroups = {};
  state.customers.forEach((c) => {
    if (!c || !c.customerNumber) return;
    const num = c.customerNumber.toString();
    if (!custGroups[num]) custGroups[num] = [];
    custGroups[num].push(c);
  });

  Object.values(custGroups).forEach((loans) => {
    if (loans.length === 1) {
      if (!loans[0].loanNumber || Number(loans[0].loanNumber) !== 1) {
        loans[0].loanNumber = 1;
        modified = true;
      }
    } else {
      // Check if loans have missing or duplicate loanNumber
      const seen = new Set();
      let hasDuplicates = false;
      loans.forEach((l) => {
        const n = Number(l.loanNumber);
        if (!n || n < 1 || seen.has(n)) hasDuplicates = true;
        seen.add(n);
      });

      if (hasDuplicates) {
        // Sort chronologically by startDate / createdAt
        loans.sort((a, b) => {
          const dateA = a.startDate || a.createdAt || '';
          const dateB = b.startDate || b.createdAt || '';
          if (dateA !== dateB) return dateA.localeCompare(dateB);
          return (a.id || '').localeCompare(b.id || '');
        });

        loans.forEach((l, idx) => {
          const expected = idx + 1;
          if (Number(l.loanNumber) !== expected) {
            l.loanNumber = expected;
            modified = true;
          }
        });
      }
    }
  });

  if (state.settings) {
    state.settings.nextCustNumber = findNextAvailableCustomerNumber(1);
  }

  // 2. Validate financial parameters & repair corrupted date formats (+046316 etc.)
  state.customers.forEach((c) => {
    if (!c) return;
    const instAmt = Number(c.instalmentAmount) || 200;
    const totInst = Number(c.totalInstalments) || 52;
    const expectedPayable = totInst * instAmt;

    if (c.totalPayable !== expectedPayable) {
      c.totalPayable = expectedPayable;
      modified = true;
    }

    if (c.startDate) {
      const cleanStart = sanitizeDateYear(c.startDate);
      if (cleanStart && cleanStart !== c.startDate) {
        c.startDate = cleanStart;
        modified = true;
      }
    }

    if (!c.instalments || !Array.isArray(c.instalments)) {
      c.instalments = [];
      modified = true;
    }

    // Expand array if shorter than totalInstalments
    if (c.instalments.length < totInst) {
      for (let i = c.instalments.length + 1; i <= totInst; i++) {
        c.instalments.push({
          number: i,
          dueAmount: instAmt,
          paidAmount: 0,
          status: 'Pending'
        });
      }
      modified = true;
    }

    // Validate each instalment: received instalments must match scheduled instalmentAmount (unless marked Partial)
    c.instalments.forEach((inst, idx) => {
      if (!inst) return;
      if (!inst.number) {
        inst.number = idx + 1;
        modified = true;
      }
      if (inst.paidDate) {
        const cleanPaidDate = sanitizeDateYear(inst.paidDate);
        if (cleanPaidDate && cleanPaidDate !== inst.paidDate) {
          inst.paidDate = cleanPaidDate;
          modified = true;
        }
      }
      if (inst.paidTimestamp) {
        const cleanTimestamp = sanitizeDateYear(inst.paidTimestamp);
        if (cleanTimestamp && cleanTimestamp !== inst.paidTimestamp) {
          inst.paidTimestamp = cleanTimestamp;
          modified = true;
        }
      }
      if (inst.status === 'Received') {
        if (Number(inst.paidAmount) !== instAmt) {
          inst.paidAmount = instAmt;
          modified = true;
        }
        if (Number(inst.dueAmount) !== instAmt) {
          inst.dueAmount = instAmt;
          modified = true;
        }
      } else if (inst.status === 'Pending') {
        if (Number(inst.dueAmount) !== instAmt) {
          inst.dueAmount = instAmt;
          modified = true;
        }
        if (Number(inst.paidAmount) !== 0) {
          inst.paidAmount = 0;
          modified = true;
        }
      } else if (inst.status === 'Partial') {
        if (Number(inst.dueAmount) !== instAmt) {
          inst.dueAmount = instAmt;
          modified = true;
        }
      }
    });
  });

  // 3. Also sanitize dates in state.transactions
  if (state.transactions && Array.isArray(state.transactions)) {
    state.transactions.forEach((t) => {
      if (!t) return;
      if (t.date) {
        const cleanD = sanitizeDateYear(t.date);
        if (cleanD && cleanD !== t.date) {
          t.date = cleanD;
          modified = true;
        }
      }
      if (t.timestamp) {
        const cleanT = sanitizeDateYear(t.timestamp);
        if (cleanT && cleanT !== t.timestamp) {
          t.timestamp = cleanT;
          modified = true;
        }
      }
    });
  }

  return modified;
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
        // Automatically filter out any starter demo data and test automation accounts (#9999)
        const isTestOrDemoCust = (c) => {
          if (!c || !c.id) return true;
          if (c.id.startsWith('DEMO-') || c.id === 'TEST-ISOLATED-AUTOMATION-CUST') return true;
          if (String(c.customerNumber) === '9999') return true;
          const name = (c.fullName || '').toLowerCase();
          if (name.includes('test automation')) return true;
          return false;
        };
        state.customers = Array.isArray(parsed) ? parsed.filter(c => !isTestOrDemoCust(c)) : [];
        healCustomerInvariants();
      } catch (e) {
        state.customers = [];
      }
    } else {
      state.customers = [];
    }

    const savedTxns = localStorage.getItem(STORAGE_KEYS.TRANSACTIONS);
    if (savedTxns) {
      try {
        state.transactions = JSON.parse(savedTxns) || [];
      } catch (e) {
        state.transactions = [];
      }
    } else {
      state.transactions = [];
    }

    const savedLocks = localStorage.getItem('jsr_finance_editing_locks');
    if (savedLocks) {
      try {
        const parsedLocks = JSON.parse(savedLocks);
        const now = Date.now();
        const activeOnly = {};
        Object.entries(parsedLocks || {}).forEach(([k, v]) => {
          if (v && v.expiresAt > now) activeOnly[k] = v;
        });
        state.activeLocks = activeOnly;
      } catch (e) {
        state.activeLocks = {};
      }
    } else {
      state.activeLocks = {};
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
    localStorage.setItem(STORAGE_KEYS.TRANSACTIONS, JSON.stringify(state.transactions || []));
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

// PRO FEATURE 6: Borrower Credit Health Rating & Next Loan Eligibility Engine
function calculateCreditRating(customer) {
  if (!customer) {
    return {
      score: 5.0,
      stars: '5.0',
      tier: 'Prime',
      badgeClass: 'credit-badge-prime',
      recommendedLimit: 25000,
      reason: 'New Customer',
    };
  }

  const totalInst = customer.totalInstalments || 52;
  const instalments = customer.instalments || [];
  let paidCount = 0;
  for (let i = 0; i < totalInst; i++) {
    const inst = instalments[i];
    if (inst && (inst.status === 'Received' || inst.status === 'Partial')) {
      paidCount++;
    }
  }

  let missed = 0;
  if (customer.startDate) {
    try {
      const startMs = new Date(customer.startDate).getTime();
      const nowMs = new Date().getTime();
      const diffDays = Math.floor((nowMs - startMs) / (1000 * 60 * 60 * 24));
      const isDaily = customer.frequency === 'Daily' || totalInst === 100;
      const expectedInst = isDaily ? Math.max(0, diffDays) : Math.max(0, Math.floor(diffDays / 7));
      const cappedExpected = Math.min(totalInst, expectedInst);
      if (cappedExpected > paidCount) {
        missed = cappedExpected - paidCount;
      }
    } catch (e) {}
  }

  const allLoans = (state.customers || []).filter(c => c.customerNumber.toString() === customer.customerNumber.toString());
  const completedCount = allLoans.filter(c => {
    const b = (c.totalPayable || (c.instalmentAmount * (c.totalInstalments || 52))) - ((c.instalments || []).reduce((sum, i) => sum + (Number(i && i.paidAmount) || 0), 0));
    return b <= 0 && !c.isSettled;
  }).length;

  const isSettled = customer.isSettled || Boolean(customer.settlement && customer.settlement.settledDate);

  let score = 5.0;
  if (missed === 0) {
    score = 5.0;
  } else if (missed <= 2) {
    score = 4.4;
  } else if (missed <= 4) {
    score = 3.6;
  } else if (missed <= 8) {
    score = 2.8;
  } else {
    score = 1.8;
  }

  if (completedCount >= 1 && score >= 3.0) {
    score = Math.min(5.0, score + 0.3 * completedCount);
  }

  if (isSettled) {
    score = Math.min(score, 3.5);
  }

  score = Math.round(score * 10) / 10;

  let tier = 'Prime';
  let badgeClass = 'credit-badge-prime';
  let limitMultiplier = 1.8;

  if (score >= 4.5) {
    tier = 'Prime';
    badgeClass = 'credit-badge-prime';
    limitMultiplier = 2.0;
  } else if (score >= 3.8) {
    tier = 'Good';
    badgeClass = 'credit-badge-good';
    limitMultiplier = 1.4;
  } else if (score >= 3.0) {
    tier = 'Fair';
    badgeClass = 'credit-badge-fair';
    limitMultiplier = 1.0;
  } else {
    tier = 'High Risk';
    badgeClass = 'credit-badge-risk';
    limitMultiplier = 0.7;
  }

  const baseGiven = Number(customer.givenAmount) || 10000;
  let recommendedLimit = Math.round((baseGiven * limitMultiplier) / 1000) * 1000;
  recommendedLimit = Math.max(5000, Math.min(100000, recommendedLimit));

  return {
    score,
    stars: score.toFixed(1),
    tier,
    badgeClass,
    recommendedLimit,
    completedCount,
    missedCount: missed,
    isSettled,
  };
}

// Helper: Calculate Customer Stats
function getCustomerStats(customer) {
  const totalInst = customer.totalInstalments || 52;
  const instalments = customer.instalments || [];
  let paidCount = 0;
  let partialCount = 0;
  let totalPaid = 0;

  for (let i = 0; i < totalInst; i++) {
    const inst = instalments[i];
    if (inst) {
      if (inst.status === 'Received') {
        paidCount++;
        totalPaid += (Number(inst.paidAmount) || customer.instalmentAmount);
      } else if (inst.status === 'Partial') {
        partialCount++;
        totalPaid += (Number(inst.paidAmount) || 0);
      }
    }
  }

  const pendingCount = Math.max(0, totalInst - paidCount);
  const totalPayable = customer.totalPayable || (customer.instalmentAmount * totalInst);
  const balance = Math.max(0, totalPayable - totalPaid);
  const isCompleted = balance <= 0 || paidCount >= totalInst || customer.isSettled;
  const progressPercent = Math.min(100, Math.round((totalPaid / (totalPayable || 1)) * 100));

  // Overdue calculation (Behind schedule by 2 or more instalments)
  let isOverdue = false;
  let missedCount = 0;
  if (!isCompleted && customer.startDate) {
    try {
      const startMs = new Date(customer.startDate).getTime();
      const nowMs = new Date().getTime();
      const diffDays = Math.floor((nowMs - startMs) / (1000 * 60 * 60 * 24));
      const isDaily = customer.frequency === 'Daily' || (customer.totalInstalments || 52) === 100;
      const expectedInst = isDaily ? Math.max(0, diffDays) : Math.max(0, Math.floor(diffDays / 7));
      const cappedExpected = Math.min(totalInst, expectedInst);
      if (cappedExpected - paidCount >= 2) {
        isOverdue = true;
        missedCount = cappedExpected - paidCount;
      }
    } catch (e) {
      // ignore date parse error
    }
  }

  // Profit calculations (Proportional Accounting Invariant: principalRecovered + realizedProfit === totalPaid)
  const given = Number(customer.givenAmount) || 0;
  const expectedProfit = Math.max(0, totalPayable - given);
  const profitMarginRate = totalPayable > 0 ? (expectedProfit / totalPayable) : 0;
  const profitReturnPercent = given > 0 ? Math.round((expectedProfit / given) * 1000) / 10 : 0;
  const realizedProfit = Math.round(totalPaid * profitMarginRate);
  const principalRecovered = Math.max(0, totalPaid - realizedProfit);

  const isAtRisk = !isCompleted && (missedCount >= 4 || (isOverdue && missedCount >= 3));

  return {
    paidCount,
    partialCount,
    pendingCount,
    totalPaid,
    totalPayable,
    balance,
    progressPercent,
    expectedProfit,
    realizedProfit,
    principalRecovered,
    profitReturnPercent,
    isCompleted,
    isOverdue,
    missedCount,
    overdueCount: missedCount,
    isAtRisk,
    dueToDate: typeof cappedExpected !== 'undefined' ? cappedExpected : paidCount,
    creditRating: calculateCreditRating(customer),
  };
}

// Helper: Global Portfolio Metrics
function getPortfolioStats(loanFilter = 'all') {
  let totalDisbursed = 0;
  let totalCollected = 0;
  let totalPayable = 0;
  let totalBalance = 0;
  let activeLoans = 0;
  let completedLoans = 0;
  let todayCollected = 0;
  let totalExpectedProfit = 0;
  let totalRealizedProfit = 0;

  const todayStr = getISTDateString();
  const targetLoan = (loanFilter && loanFilter !== 'all') ? Number(loanFilter) : null;

  const targetCustomers = state.customers.filter((cust) => {
    if (targetLoan !== null) {
      return (Number(cust.loanNumber) || 1) === targetLoan;
    }
    return true;
  });

  targetCustomers.forEach((cust) => {
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

  });

  // Check today's collections: accurately credit partial vs full payments
  // 1. Transaction audit ledger provides 100% exact split accounting across multi-day partial payments
  let hasTodayTransactions = false;
  let txnTodayCollected = 0;
  if (state.transactions && Array.isArray(state.transactions) && state.transactions.length > 0) {
    state.transactions.forEach(t => {
      if (t && t.date === todayStr) {
        if (targetLoan !== null && (Number(t.loanNumber) || 1) !== targetLoan) {
          return;
        }
        hasTodayTransactions = true;
        const amt = Number(t.amount) || 0;
        if (t.type === 'undo') {
          txnTodayCollected -= amt;
        } else {
          txnTodayCollected += amt;
        }
      }
    });
  }

  if (hasTodayTransactions) {
    todayCollected = Math.max(0, txnTodayCollected);
  } else {
    // 2. Direct instalment fallback for legacy data or sessions without transaction records
    targetCustomers.forEach((cust) => {
      if (cust.instalments) {
        cust.instalments.forEach((inst) => {
          if (inst && inst.paidDate === todayStr) {
            if (inst.status === 'Partial') {
              todayCollected += (Number(inst.paidAmount) || 0);
            } else if (inst.status === 'Received') {
              todayCollected += (Number(inst.paidAmount) || cust.instalmentAmount || 0);
            }
          }
        });
      }
    });
  }

  const recoveryPercent = totalPayable > 0 ? Math.round((totalCollected / totalPayable) * 100) : 0;
  const todayProfit = todayCollected > 0 && totalPayable > 0 ? Math.round(todayCollected * (totalExpectedProfit / totalPayable)) : 0;
  const totalPrincipalRecovered = Math.max(0, totalCollected - totalRealizedProfit);

  return {
    totalCustomers: targetCustomers.length,
    activeLoans,
    completedLoans,
    totalDisbursed,
    totalCollected,
    totalBalance,
    totalPayable,
    todayCollected,
    totalExpectedProfit,
    totalRealizedProfit,
    totalPrincipalRecovered,
    todayProfit,
    recoveryPercent,
  };
}

// Update Logged User Badge in Sidebar Bottom and Header (if present)
function updateHeaderUserBadge() {
  const badge = document.getElementById('header-user-badge');
  const nameEl = document.getElementById('header-user-name');
  const roleEl = document.getElementById('header-user-role');
  const avatarEl = document.getElementById('header-user-avatar');

  const sCard = document.getElementById('sidebar-user-card');
  const sName = document.getElementById('sidebar-user-name');
  const sRole = document.getElementById('sidebar-user-role');
  const sAvatar = document.getElementById('sidebar-user-avatar');

  const curUser = getCurrentUser();
  let userName = 'surendra';
  let roleTag = 'FULL ACCESS';
  let initial = 'S';

  if (curUser && curUser.user) {
    userName = curUser.user;
    if (curUser.role === 'Admin') {
      roleTag = 'FULL ACCESS';
    } else {
      roleTag = curUser.role ? curUser.role.toUpperCase() : 'COLLECTOR';
    }
  } else if (state.settings && state.settings.adminEmail) {
    userName = state.settings.adminEmail.split('@')[0];
    roleTag = 'FULL ACCESS';
  }

  if (userName.includes('@')) {
    userName = userName.split('@')[0];
  }
  initial = (userName.charAt(0) || 'S').toUpperCase();

  if (nameEl) nameEl.textContent = userName;
  if (roleEl) roleEl.textContent = roleTag;
  if (avatarEl) avatarEl.textContent = initial;
  if (badge) badge.title = `Logged in as ${userName} (${roleTag}). Click to open Settings.`;

  if (sName) sName.textContent = userName;
  if (sRole) sRole.textContent = roleTag;
  if (sAvatar) sAvatar.textContent = initial;
  if (sCard) sCard.title = `Logged in as ${userName} (${roleTag}). Click to open Settings.`;
}

// Update Persistent Header Stats
function updateHeaderStats() {
  const stats = getPortfolioStats('all');
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

  // Synchronize active logged user pill
  updateHeaderUserBadge();
}

// Navigation & Tab Switching
function switchTab(tabName) {
  // Safe default: enforce valid tab names, fallback to 'collections'
  const validTabs = ['collections', 'summary', 'customers', 'analytics', 'settings'];
  if (!tabName || !validTabs.includes(tabName)) {
    tabName = 'collections';
  }

  checkAndPromptUnsaved(null, () => {
    state.activeTab = tabName;

    document.querySelectorAll('.nav-link[data-tab]').forEach((link) => {
      link.classList.toggle('active', link.dataset.tab === tabName);
    });

    document.querySelectorAll('.mobile-nav-item[data-tab]').forEach((item) => {
      item.classList.toggle('active', item.dataset.tab === tabName);
    });

    document.querySelectorAll('.mobile-header-btn[data-tab]').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
    });

    document.querySelectorAll('.screen-view').forEach((view) => {
      view.classList.toggle('active', view.id === `view-${tabName}`);
    });

    const sidebar = document.getElementById('app-sidebar');
    if (sidebar) {
      sidebar.classList.add('force-collapsed');
      setTimeout(() => {
        sidebar.classList.remove('force-collapsed');
      }, 300);
    }

    window.scrollTo({ top: 0, behavior: 'smooth' });
    const contentArea = document.querySelector('.content-area');
    if (contentArea) contentArea.scrollTo({ top: 0, behavior: 'smooth' });

    if (tabName === 'summary') renderDashboard();
    if (tabName === 'collections') renderCollectionMatrix();
    if (tabName === 'customers') renderCustomersTable();
    if (tabName === 'analytics') renderAnalytics();
    if (tabName === 'settings') renderSettings();
  });
}

// ----------------------------------------------------
// SCREEN 1: SUMMARY SCREEN (DASHBOARD)
// ----------------------------------------------------
function handleSummaryLoanFilterChange(val) {
  const recentLoan = document.getElementById('recent-loan-filter');
  if (recentLoan) {
    recentLoan.value = val;
  }
  renderDashboard();
}

function handleCollectionLoanFilterChange(val) {
  state.collectionLoanFilter = val;
  renderCollectionMatrix();
}

function renderDashboard() {
  const loanFilterEl = document.getElementById('summary-loan-filter');

  // Dynamically populate available loan numbers in summary-loan-filter
  if (loanFilterEl) {
    const currentVal = loanFilterEl.value || 'all';
    const uniqueLoans = Array.from(new Set([
      ...state.customers.map(c => Number(c.loanNumber) || 1),
      ...(state.transactions || []).map(t => Number(t.loanNumber) || 1)
    ])).sort((a, b) => a - b);

    loanFilterEl.innerHTML = '<option value="all">📋 All Loans (Overall)</option>';
    uniqueLoans.forEach(ln => {
      const opt = document.createElement('option');
      opt.value = ln.toString();
      opt.textContent = `Loan #${ln} (L${ln})`;
      loanFilterEl.appendChild(opt);
    });
    if (uniqueLoans.map(String).includes(currentVal)) {
      loanFilterEl.value = currentVal;
    } else {
      loanFilterEl.value = 'all';
    }
  }

  const activeLoan = loanFilterEl ? loanFilterEl.value : 'all';
  const stats = getPortfolioStats(activeLoan);

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

  // Milestone distribution counts (filtered by active loan if specified)
  let w1to10 = 0, w11to25 = 0, w26to40 = 0, w41to52 = 0;
  const targetCustomers = activeLoan !== 'all'
    ? state.customers.filter(c => (Number(c.loanNumber) || 1) === Number(activeLoan))
    : state.customers;

  targetCustomers.forEach((c) => {
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

  // Render Admin-Only Today's Operator Collections Breakdown
  renderCollectorBreakdownWidget();

  // Render filtered recent transactions feed
  renderRecentTransactions();
}

// Recent Collections & Audit Feed with Interactive Filtering (Supports Undos & Net Calculation)
function renderRecentTransactions() {
  const recentList = document.getElementById('recent-transactions-list');
  if (!recentList) return;

  const typeFilter = document.getElementById('recent-type-filter')?.value || 'all';
  const loanFilter = document.getElementById('recent-loan-filter')?.value || 'all';
  const dateFilter = document.getElementById('recent-date-filter')?.value || 'all';
  const searchQuery = (document.getElementById('recent-search-filter')?.value || '').toLowerCase().trim();
  const routeFilter = document.getElementById('recent-route-filter')?.value || 'all';

  // Dynamically refresh loan dropdown while preserving active selection
  const loanSelect = document.getElementById('recent-loan-filter');
  if (loanSelect) {
    const currentLoanVal = loanSelect.value || 'all';
    const uniqueLoans = Array.from(new Set([
      ...state.customers.map(c => Number(c.loanNumber) || 1),
      ...(state.transactions || []).map(t => Number(t.loanNumber) || 1)
    ])).sort((a, b) => a - b);

    loanSelect.innerHTML = '<option value="all">📋 All Loans</option>';
    uniqueLoans.forEach(ln => {
      const opt = document.createElement('option');
      opt.value = ln.toString();
      opt.textContent = `Loan #${ln} (L${ln})`;
      loanSelect.appendChild(opt);
    });
    if (uniqueLoans.map(String).includes(currentLoanVal)) {
      loanSelect.value = currentLoanVal;
    } else {
      loanSelect.value = 'all';
    }
  }

  // Dynamically refresh route dropdown while preserving active selection
  const routeSelect = document.getElementById('recent-route-filter');
  if (routeSelect) {
    const currentVal = routeSelect.value || 'all';
    const uniqueRoutes = Array.from(new Set(state.customers.map(c => c.areaRoute).filter(Boolean))).sort();
    routeSelect.innerHTML = '<option value="all">📍 All Routes</option>';
    uniqueRoutes.forEach(route => {
      const opt = document.createElement('option');
      opt.value = route;
      opt.textContent = `📍 ${route}`;
      routeSelect.appendChild(opt);
    });
    if (uniqueRoutes.includes(currentVal)) {
      routeSelect.value = currentVal;
    } else {
      routeSelect.value = 'all';
    }
  }

  // Dynamically refresh collector dropdown while preserving active selection
  const collectorSelect = document.getElementById('recent-collector-filter');
  if (collectorSelect) {
    const currentCollectorVal = collectorSelect.value || 'all';
    const allCollectors = [
      { id: 'Admin', label: '👑 Admin (Personal Collections)' },
      ...(Array.isArray(state.settings.collectors) ? state.settings.collectors.map(c => ({ id: c.name, label: `🛵 ${c.name}` })) : [])
    ];
    let opts = '<option value="all">👤 All Operators</option>';
    allCollectors.forEach(col => {
      opts += `<option value="${col.id}">${col.label}</option>`;
    });
    collectorSelect.innerHTML = opts;
    if (['all', ...allCollectors.map(c => c.id)].includes(currentCollectorVal)) {
      collectorSelect.value = currentCollectorVal;
    } else {
      collectorSelect.value = 'all';
    }
  }

  // Get current date benchmarks in Indian Standard Time (IST)
  const now = new Date();
  const todayStr = getISTDateString(now);
  const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
  const yesterdayStr = getISTDateString(yesterday);
  const weekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
  const weekAgoStr = getISTDateString(weekAgo);
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthStartStr = getISTDateString(monthStart);

  let allItems = [];
  const recordedKeys = new Set();

  if (state.transactions && state.transactions.length > 0) {
    // Primary path: Use comprehensive transaction audit ledger (preserves all payments & undos)
    state.transactions.forEach((t) => {
      const targetLoan = Number(t.loanNumber) || 1;
      const cust = (t.customerId ? state.customers.find(c => c.id === t.customerId) : null) ||
                   state.customers.find(c => 
                     c.customerNumber && c.customerNumber.toString() === (t.customerNumber || '').toString() &&
                     (Number(c.loanNumber) || 1) === targetLoan
                   ) ||
                   state.customers.find(c => c.customerNumber && c.customerNumber.toString() === (t.customerNumber || '').toString());

      const loanNum = Number(t.loanNumber) || (cust ? Number(cust.loanNumber) : 1) || 1;
      allItems.push({
        customerId: t.customerId || (cust ? cust.id : ''),
        customerNumber: t.customerNumber || (cust ? cust.customerNumber : ''),
        loanNumber: loanNum,
        customerName: t.customerName || (cust ? cust.fullName : 'Customer'),
        areaRoute: (cust && cust.areaRoute) ? cust.areaRoute : 'General',
        instNumber: t.instalmentNumber,
        paidDate: t.date || todayStr,
        timestamp: t.timestamp || '',
        amount: Number(t.amount) || 0,
        receiptNumber: t.receiptNumber || '',
        type: t.type || 'payment',
        collector: t.collector || 'Admin',
        status: t.type === 'undo' ? 'Undo' : (t.type === 'partial' ? 'Partial' : 'Received')
      });
      recordedKeys.add(`${t.customerId || (cust ? cust.id : '')}_L${loanNum}_W${t.instalmentNumber}`);
    });
  }

  // Also include any active customer instalments not yet recorded in transactions (e.g. legacy/imported data)
  state.customers.forEach((c) => {
    const cLoanNum = Number(c.loanNumber) || 1;
    const cInstAmt = Number(c.instalmentAmount) || 200;
    (c.instalments || []).forEach((inst) => {
      if (inst && (inst.status === 'Received' || inst.status === 'Partial')) {
        const key = `${c.id}_L${cLoanNum}_W${inst.number}`;
        if (!recordedKeys.has(key)) {
          const instPaid = (inst.status === 'Received') ? (Number(inst.paidAmount) || cInstAmt) : (Number(inst.paidAmount) || 0);
          allItems.push({
            customerId: c.id,
            customerNumber: c.customerNumber,
            loanNumber: cLoanNum,
            customerName: c.fullName,
            areaRoute: c.areaRoute || 'General',
            instNumber: inst.number,
            paidDate: inst.paidDate || todayStr,
            timestamp: inst.paidTimestamp || '',
            amount: instPaid,
            receiptNumber: inst.receiptNumber || `REC-${inst.number}`,
            type: inst.status === 'Partial' ? 'partial' : 'payment',
            collector: inst.paidBy || 'Admin',
            status: inst.status,
          });
        }
      }
    });
  });

  // Apply filters
  const filtered = allItems.filter(item => {
    // Type Filter (payment, partial, undo)
    if (typeFilter === 'payment' && item.type !== 'payment') return false;
    if (typeFilter === 'partial' && item.type !== 'partial') return false;
    if (typeFilter === 'undo' && item.type !== 'undo') return false;

    // Loan Number Filter
    if (loanFilter !== 'all') {
      const targetLoanNum = Number(loanFilter);
      if ((Number(item.loanNumber) || 1) !== targetLoanNum) return false;
    }

    // Date filter
    const itemDate = item.paidDate;
    if (dateFilter === 'today' && itemDate !== todayStr && itemDate !== 'Today') return false;
    if (dateFilter === 'yesterday' && itemDate !== yesterdayStr) return false;
    if (dateFilter === 'this-week' && itemDate < weekAgoStr) return false;
    if (dateFilter === 'this-month' && itemDate < monthStartStr) return false;

    // Search filter
    if (searchQuery) {
      const matchNum = (item.customerNumber || '').toString().includes(searchQuery);
      const matchName = (item.customerName || '').toLowerCase().includes(searchQuery);
      if (!matchNum && !matchName) return false;
    }

    // Route filter
    if (routeFilter !== 'all' && item.areaRoute !== routeFilter) return false;

    // Collector filter
    const collectorFilter = document.getElementById('recent-collector-filter')?.value || 'all';
    if (collectorFilter !== 'all') {
      if (collectorFilter === 'Admin') {
        const isAdm = !item.collector || item.collector === 'Admin' || item.collector.toLowerCase().includes('admin');
        if (!isAdm) return false;
      } else {
        if (item.collector !== collectorFilter) return false;
      }
    }

    return true;
  });

  // Sort descending by timestamp/date
  filtered.sort((a, b) => {
    const timeA = a.timestamp || a.paidDate || '';
    const timeB = b.timestamp || b.paidDate || '';
    return timeB.localeCompare(timeA);
  });

  // Calculate net collections (Received/Partial are positive, Undone are negative)
  let totalReceived = 0;
  let totalUndone = 0;
  filtered.forEach(item => {
    if (item.type === 'undo') {
      totalUndone += item.amount;
    } else {
      totalReceived += item.amount;
    }
  });
  const netTotal = totalReceived - totalUndone;

  // Update Summary count
  const countEl = document.getElementById('recent-summary-count');
  if (countEl) {
    if (totalUndone > 0) {
      countEl.innerHTML = `Showing <strong>${filtered.length}</strong> activities · Net: <strong style="color: ${netTotal >= 0 ? '#16a34a' : '#dc2626'};">${formatMoney(netTotal)}</strong> <span style="font-size:11px; color:#64748b;">(Collected: +${formatMoney(totalReceived)} · Undone: -${formatMoney(totalUndone)})</span>`;
    } else {
      countEl.innerHTML = `Showing <strong>${filtered.length}</strong> collections · Total: <strong style="color:#16a34a;">${formatMoney(netTotal)}</strong>`;
    }
  }

  if (filtered.length === 0) {
    recentList.innerHTML = `<tr><td colspan="6" style="text-align:center; padding:24px; color:#94a3b8;">No collections or audit records match the selected filters.</td></tr>`;
  } else {
    recentList.innerHTML = filtered.slice(0, 50).map((item) => {
      const isUndo = item.type === 'undo';
      const isPartial = item.type === 'partial' || item.status === 'Partial';

      let amountHtml = `<span style="color:#16a34a; font-weight:700;">+ ${formatMoney(item.amount)}</span>`;
      let statusHtml = `<span class="badge-status badge-status-success">✓ Received</span>`;

      if (isUndo) {
        amountHtml = `<span style="color:#dc2626; font-weight:700;">- ${formatMoney(item.amount)}</span>`;
        statusHtml = `<span class="badge-status badge-status-undo tx-badge-undo" style="background:#fee2e2; color:#b91c1c; border:1px solid #fca5a5; font-weight:700;">↩️ Undone</span>`;
      } else if (isPartial) {
        amountHtml = `<span style="color:#ea580c; font-weight:700;">+ ${formatMoney(item.amount)}</span>`;
        statusHtml = `<span class="badge-status badge-status-partial">½ Partial</span>`;
      }

      return `
        <tr style="${isUndo ? 'background:#fff1f2;' : ''}">
          <td>
            <strong>#${item.customerNumber}</strong>${item.loanNumber > 1 ? ` <span class="loan-badge">L${item.loanNumber}</span>` : ''} - ${item.customerName}
          </td>
          <td>Instalment #${item.instNumber}</td>
          <td>${amountHtml}</td>
          <td>
            <div>${formatPassbookDate(item.paidDate, false)}</div>
            ${(function(ts) {
              if (!ts) return '';
              const str = String(ts).trim();
              if (str.includes(' ')) return `<div style="font-size:10.5px; color:#94a3b8;">${str.split(' ').slice(1).join(' ')}</div>`;
              if (str.includes('T')) return `<div style="font-size:10.5px; color:#94a3b8;">${str.split('T')[1].slice(0, 5)}</div>`;
              return '';
            })(item.timestamp)}
          </td>
          <td>
            <span style="background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:4px; font-size:11px;">${item.areaRoute}</span>
            <div style="font-size:11px; color:#2563eb; font-weight:600; margin-top:2px;">👤 ${item.collector || 'Admin'}</div>
          </td>
          <td>${statusHtml}</td>
        </tr>
      `;
    }).join('');
  }
}

// ----------------------------------------------------
// ANALYTICS & INSIGHTS ENGINE (SCREENSHOTS 1-5 FIDELITY)
// ----------------------------------------------------

function escapeHtml(str) {
  if (str == null) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

state.analyticsPeriod = state.analyticsPeriod || 'all'; // 'today', 'week', 'month', 'all'
state.analyticsFinPeriod = state.analyticsFinPeriod || 'today'; // 'today', 'week', 'month', 'total'
state.analyticsSubnav = state.analyticsSubnav || 'overview';
state.analyticsRouteFilter = state.analyticsRouteFilter || 'all';
state.analyticsFollowupFilter = state.analyticsFollowupFilter || 'all';
state.analyticsAccordions = state.analyticsAccordions || {
  profit: false,
  loans: true,
  'sum-collection': true,
  'sum-loans': false,
  'sum-profit': false
};

function setAnalyticsPeriod(period) {
  state.analyticsPeriod = period;
  document.querySelectorAll('.ana-period-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-period') === period);
  });
  renderAnalytics();
}

function setFinOverviewPeriod(range) {
  state.analyticsFinPeriod = range;
  document.querySelectorAll('.ana-fin-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-range') === range);
  });
  renderFinancialOverviewCard();
}

function setAnalyticsSubnav(tab) {
  state.analyticsSubnav = tab;
  document.querySelectorAll('.ana-subnav-pills:not(.mini) .ana-subnav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.getAttribute('data-tab') === tab);
  });

  if (tab === 'overview') {
    const el = document.getElementById('ana-module-collections');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  } else if (tab === 'collections') {
    const el = document.getElementById('ana-module-collections');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (tab === 'profit') {
    state.analyticsAccordions.profit = true;
    updateAnalyticsAccordionsDOM();
    const el = document.getElementById('ana-module-profit');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (tab === 'loans') {
    state.analyticsAccordions.loans = true;
    updateAnalyticsAccordionsDOM();
    const el = document.getElementById('ana-module-loans');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (tab === 'routes') {
    const el = document.getElementById('ana-module-routes');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  } else if (tab === 'risk') {
    const el = document.getElementById('ana-module-risk');
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

function toggleAnalyticsAccordion(accId) {
  state.analyticsAccordions[accId] = !state.analyticsAccordions[accId];
  updateAnalyticsAccordionsDOM();
}

function updateAnalyticsAccordionsDOM() {
  ['profit', 'loans', 'sum-collection', 'sum-loans', 'sum-profit'].forEach(id => {
    const isOpen = !!state.analyticsAccordions[id];
    const body = document.getElementById(`ana-acc-body-${id}`);
    const chev = document.getElementById(`ana-chevron-${id}`);
    if (body) body.style.display = isOpen ? 'block' : 'none';
    if (chev) chev.classList.toggle('open', isOpen);
  });
}

function filterAnalyticsRoutes(route) {
  state.analyticsRouteFilter = route;
  renderAnalyticsRouteList();
}

function filterAnalyticsFollowups(filterType) {
  state.analyticsFollowupFilter = filterType || 'all';

  const sel = document.getElementById('ana-followup-select');
  if (sel && sel.value !== state.analyticsFollowupFilter) {
    sel.value = state.analyticsFollowupFilter;
  }

  const itemOverdue = document.getElementById('ana-fu-item-overdue');
  const itemAtrisk = document.getElementById('ana-fu-item-atrisk');
  const itemCompleted = document.getElementById('ana-fu-item-completed');

  if (itemOverdue) {
    itemOverdue.classList.toggle('is-selected', state.analyticsFollowupFilter === 'overdue');
    itemOverdue.style.display = (state.analyticsFollowupFilter === 'all' || state.analyticsFollowupFilter === 'overdue') ? 'flex' : 'none';
  }
  if (itemAtrisk) {
    itemAtrisk.classList.toggle('is-selected', state.analyticsFollowupFilter === 'atrisk');
    itemAtrisk.style.display = (state.analyticsFollowupFilter === 'all' || state.analyticsFollowupFilter === 'atrisk') ? 'flex' : 'none';
  }
  if (itemCompleted) {
    itemCompleted.classList.toggle('is-selected', state.analyticsFollowupFilter === 'completed');
    itemCompleted.style.display = (state.analyticsFollowupFilter === 'all' || state.analyticsFollowupFilter === 'completed') ? 'flex' : 'none';
  }

  renderAnalyticsFollowupCustomers();
}

function switchTabWithFollowupFilter(filterType) {
  switchTab('collections');
  if (filterType && filterType !== 'all') {
    state.filterStatus = filterType === 'atrisk' ? 'overdue' : filterType;
  } else {
    state.filterStatus = 'all';
  }
  const filterSelect = document.getElementById('collection-filter-select');
  if (filterSelect) {
    filterSelect.value = state.filterStatus;
  }
  renderCollectionMatrix();
}

function scrollToFollowups(filterType) {
  filterAnalyticsFollowups(filterType || 'overdue');
  const el = document.getElementById('ana-module-risk');
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

function jumpToCustomerSchedule(customerId) {
  if (!customerId) return;
  switchTab('collections');

  state.filterStatus = 'all';
  const filterSelect = document.getElementById('collection-filter-select');
  if (filterSelect) filterSelect.value = 'all';

  state.collectionLoanFilter = 'all';
  const loanFilterSelect = document.getElementById('collection-loan-filter');
  if (loanFilterSelect) loanFilterSelect.value = 'all';

  if (!state.expandedCustomerIds) state.expandedCustomerIds = new Set();
  state.expandedCustomerIds.add(customerId);

  renderCollectionMatrix();

  setTimeout(() => {
    const card = document.querySelector(`.cust-compact-card[data-customer-id="${customerId}"]`);
    if (card) {
      card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      card.classList.add('highlight-glow');
      setTimeout(() => card.classList.remove('highlight-glow'), 3000);
    }
  }, 150);
}

function renderAnalyticsFollowupCustomers() {
  const container = document.getElementById('ana-followup-customers-list');
  if (!container) return;

  const filterType = state.analyticsFollowupFilter || 'all';
  const customers = state.customers || [];

  // Group count loans per customerNumber
  const custGroupCounts = {};
  customers.forEach(c => {
    if (!c || !c.customerNumber) return;
    const num = String(c.customerNumber);
    custGroupCounts[num] = (custGroupCounts[num] || 0) + 1;
  });

  const enriched = customers.map(c => {
    const stats = getCustomerStats(c);
    const totalCustLoans = custGroupCounts[String(c.customerNumber)] || 1;
    const isOverdue = stats.isOverdue || (stats.missedCount && stats.missedCount >= 2);
    const isAtRisk = stats.isAtRisk || (stats.missedCount && stats.missedCount >= 4);
    return {
      customer: c,
      stats,
      totalCustLoans,
      isOverdue,
      isAtRisk,
      isCompleted: stats.isCompleted
    };
  });

  let filtered = [];
  if (filterType === 'overdue') {
    filtered = enriched.filter(e => e.isOverdue && !e.isCompleted);
  } else if (filterType === 'atrisk') {
    filtered = enriched.filter(e => e.isAtRisk && !e.isCompleted);
  } else if (filterType === 'completed') {
    filtered = enriched.filter(e => e.isCompleted);
  } else {
    // 'all': Show overdue and at-risk loans primarily, then completed if none
    filtered = enriched.filter(e => (e.isOverdue || e.isAtRisk) && !e.isCompleted);
    if (filtered.length === 0) {
      filtered = enriched.filter(e => e.isCompleted);
    }
  }

  // Sort: highest missedCount first, then customerNumber
  filtered.sort((a, b) => {
    const missedDiff = (b.stats.missedCount || 0) - (a.stats.missedCount || 0);
    if (missedDiff !== 0) return missedDiff;
    return (Number(a.customer.customerNumber) || 0) - (Number(b.customer.customerNumber) || 0);
  });

  const countBadge = document.getElementById('ana-fu-list-count');
  if (countBadge) {
    countBadge.textContent = `${filtered.length} loan${filtered.length !== 1 ? 's' : ''}`;
  }

  if (filtered.length === 0) {
    const emptyMsg = filterType === 'overdue' 
      ? '🎉 No overdue instalments! All active loans are on schedule.' 
      : (filterType === 'atrisk' ? '🎉 No at-risk loans! All accounts healthy.' : 'No customer records match this filter.');
    container.innerHTML = `<div class="ana-fu-empty-state">${emptyMsg}</div>`;
    return;
  }

  let html = '';
  filtered.forEach(item => {
    const c = item.customer;
    const stats = item.stats;
    const loanNum = Number(c.loanNumber) || 1;
    const totalLoans = item.totalCustLoans;
    const initials = getCustomerInitials(c.fullName);
    const avatarStyle = getCustomerAvatarStyle(c.fullName, c.customerNumber);
    const unitLabel = (c.frequency === 'Daily' || (c.totalInstalments || 52) === 100) ? 'Day' : 'Week';

    let statusBadge = '';
    if (item.isAtRisk) {
      statusBadge = `<span class="badge-status badge-status-atrisk" style="background:#fee2e2; color:#b91c1c; border:1px solid #f87171; font-size:11px; font-weight:700; padding:2px 7px; border-radius:6px;" title="High Risk: Borrower is ${stats.missedCount} instalments behind schedule">⚠️ At Risk • ${stats.missedCount} Overdue</span>`;
    } else if (item.isOverdue) {
      statusBadge = `<span class="badge-overdue" style="font-size:11px; font-weight:700; padding:2px 7px; border-radius:6px;" title="Delayed Schedule: Borrower is ${stats.missedCount} instalments behind schedule">⚠️ ${stats.missedCount} Overdue</span>`;
    } else if (item.isCompleted) {
      statusBadge = `<span class="badge-status badge-status-completed" style="background:#dcfce7; color:#15803d; border:1px solid #86efac; font-size:11px; font-weight:700; padding:2px 7px; border-radius:6px;">✅ Completed</span>`;
    }

    const loanLabel = totalLoans > 1 ? `Loan #${loanNum} (of ${totalLoans} loans)` : `Loan #${loanNum}`;

    html += `
      <div class="ana-fu-cust-card" onclick="jumpToCustomerSchedule('${c.id}')" title="Click to open ${escapeHtml(c.fullName)} in Instalment Sheet">
        <div class="ana-fu-cust-header">
          <div class="ana-fu-cust-left">
            <span class="ana-fu-cust-prefix">#${c.customerNumber}</span>
            <div class="ana-fu-avatar" style="${avatarStyle}">${initials}</div>
            <div class="ana-fu-name-block">
              <div class="ana-fu-name-row">
                <strong class="ana-fu-cust-name">${escapeHtml(c.fullName)}</strong>
                <span class="cust-loan-badge">L${loanNum}</span>
                <span class="ana-fu-loan-tag">${loanLabel}</span>
                ${statusBadge}
              </div>
              <div class="ana-fu-sub-meta">
                ${c.areaRoute ? `📍 ${escapeHtml(c.areaRoute)} • ` : ''}📞 ${escapeHtml(c.phone || 'No phone')}
              </div>
            </div>
          </div>
          <div class="ana-fu-cust-right" style="display: flex; align-items: center; gap: 6px;">
            ${(c.guarantor && c.guarantor.phone) ? `
              <button type="button" class="btn btn-sm" style="font-size:11px; padding:4px 8px; background:#f0fdf4; color:#166534; border:1px solid #86efac; font-weight:700; border-radius:6px; cursor:pointer;" onclick="event.stopPropagation(); contactGuarantor('${c.id}', 'whatsapp')" title="Send recovery alert to Guarantor ${c.guarantor.name}">
                👥 WA Guarantor
              </button>
            ` : ''}
            <button type="button" class="ana-fu-open-btn" onclick="event.stopPropagation(); jumpToCustomerSchedule('${c.id}')">
              Open Schedule →
            </button>
          </div>
        </div>
        <div class="ana-fu-financial-strip">
          <div class="ana-fu-fin-col">
            <span class="ana-fu-fin-label">Paid / Due</span>
            <span class="ana-fu-fin-val">${stats.paidCount}/${c.totalInstalments || 52} ${unitLabel}s</span>
          </div>
          <div class="ana-fu-fin-col">
            <span class="ana-fu-fin-label">Instalment</span>
            <span class="ana-fu-fin-val">${formatMoney(c.instalmentAmount)}/${unitLabel.toLowerCase()}</span>
          </div>
          <div class="ana-fu-fin-col">
            <span class="ana-fu-fin-label">Collected</span>
            <span class="ana-fu-fin-val text-green">${formatMoney(stats.totalPaid)}</span>
          </div>
          <div class="ana-fu-fin-col">
            <span class="ana-fu-fin-label">Pending Balance</span>
            <span class="ana-fu-fin-val text-amber">${formatMoney(stats.balance)}</span>
          </div>
        </div>
      </div>
    `;
  });

  container.innerHTML = html;
}

function filterSummaryAccordions(tab, btn) {
  if (btn && btn.parentElement) {
    btn.parentElement.querySelectorAll('.ana-subnav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  }
  if (tab === 'overview') {
    state.analyticsAccordions['sum-collection'] = true;
    state.analyticsAccordions['sum-loans'] = false;
    state.analyticsAccordions['sum-profit'] = false;
  } else if (tab === 'collections') {
    state.analyticsAccordions['sum-collection'] = true;
    state.analyticsAccordions['sum-loans'] = false;
    state.analyticsAccordions['sum-profit'] = false;
  } else if (tab === 'loans') {
    state.analyticsAccordions['sum-collection'] = false;
    state.analyticsAccordions['sum-loans'] = true;
    state.analyticsAccordions['sum-profit'] = false;
  } else if (tab === 'profit') {
    state.analyticsAccordions['sum-collection'] = false;
    state.analyticsAccordions['sum-loans'] = false;
    state.analyticsAccordions['sum-profit'] = true;
  } else if (tab === 'risk') {
    state.analyticsAccordions['sum-collection'] = true;
    state.analyticsAccordions['sum-loans'] = false;
    state.analyticsAccordions['sum-profit'] = false;
  }
  updateAnalyticsAccordionsDOM();
}

function renderAnalyticsRouteList() {
  const container = document.getElementById('ana-routes-cards-list');
  if (!container) return;
  const routeMap = state._lastAnalyticsRouteMap || {};
  let list = Object.values(routeMap);

  if (state.analyticsRouteFilter && state.analyticsRouteFilter !== 'all') {
    list = list.filter(r => r.route === state.analyticsRouteFilter);
  }

  if (list.length === 0) {
    container.innerHTML = '<div style="text-align: center; color: #94a3b8; padding: 18px; font-size: 13px;">No route performance records found.</div>';
    return;
  }

  container.innerHTML = list.map(r => {
    const recPct = r.disbursed > 0 ? Math.round((r.collected / r.disbursed) * 100) : 0;
    const badgeClass = recPct >= 50 ? 'is-high' : 'is-mid';
    return `
      <div class="ana-route-card">
        <div class="ana-route-top">
          <span class="ana-route-name">${escapeHtml(r.route)}</span>
          <span class="ana-route-badge ${badgeClass}">${recPct}% recovery</span>
        </div>
        <div class="ana-route-meta">
          <span>${r.count} loan${r.count !== 1 ? 's' : ''}</span>
          <span>Collected ${formatMoney(r.collected)}</span>
        </div>
        <div class="ana-route-track">
          <div class="ana-route-fill" style="width: ${Math.min(100, recPct)}%;"></div>
        </div>
        <div class="ana-route-bottom">
          Disbursed ${formatMoney(r.disbursed)}
        </div>
      </div>
    `;
  }).join('');
}

function renderFinancialOverviewCard() {
  const customers = state.customers || [];
  const range = state.analyticsFinPeriod || 'today';
  const now = new Date();
  const todayStr = getISTDateString(now);

  const dayOfWeek = (now.getDay() + 6) % 7; // Monday = 0
  const currentMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
  const currentSunday = new Date(currentMonday.getTime() + 6 * 24 * 60 * 60 * 1000);
  const weekStartStr = getISTDateString(currentMonday);
  const weekEndStr = getISTDateString(currentSunday);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const monthStartStr = getISTDateString(monthStart);
  const monthEndStr = getISTDateString(monthEnd);

  function matchesRange(dateStr) {
    if (!dateStr) return false;
    if (range === 'today') return dateStr === todayStr;
    if (range === 'week') return dateStr >= weekStartStr && dateStr <= weekEndStr;
    if (range === 'month') return dateStr >= monthStartStr && dateStr <= monthEndStr;
    return true; // 'total'
  }

  let rangeCollected = 0;
  let rangeProfit = 0;
  let activeCustomersSet = new Set();
  let loansIssuedInRange = 0;

  // Tally collections from transactions if present
  if (state.transactions && state.transactions.length > 0) {
    state.transactions.forEach(txn => {
      if (matchesRange(txn.date)) {
        const amt = Number(txn.amount) || 0;
        if (txn.type === 'undo') {
          rangeCollected = Math.max(0, rangeCollected - amt);
        } else {
          rangeCollected += amt;
          if (txn.customerId) activeCustomersSet.add(txn.customerId);
        }
      }
    });
  } else {
    customers.forEach(c => {
      (c.instalments || []).forEach(inst => {
        if (inst && (inst.status === 'Received' || inst.status === 'Partial') && matchesRange(inst.paidDate)) {
          const amt = Number(inst.paidAmount) || (inst.status === 'Received' ? c.instalmentAmount : 0) || 0;
          rangeCollected += amt;
          activeCustomersSet.add(c.id);
        }
      });
    });
  }

  // Count loans issued in range
  customers.forEach(c => {
    if (matchesRange(c.startDate || c.createdAt)) {
      loansIssuedInRange++;
    }
  });

  // Calculate proportional profit estimate for range
  let totalDisbursed = 0;
  let totalPayable = 0;
  customers.forEach(c => {
    const s = getCustomerStats(c);
    totalDisbursed += (c.givenAmount || 0);
    totalPayable += (s.totalPayable || 0);
  });
  const overallMarginRate = totalPayable > 0 ? (totalPayable - totalDisbursed) / totalPayable : 0.04;
  rangeProfit = Math.round(rangeCollected * overallMarginRate);

  // Determine Target for the selected period
  let targetAmt = 0;
  let activeCount = customers.filter(c => !getCustomerStats(c).isCompleted).length;
  let weeklyRunRate = 0;
  customers.forEach(c => {
    if (!getCustomerStats(c).isCompleted) {
      const isDaily = c.frequency === 'Daily' || (c.totalInstalments || 52) === 100;
      weeklyRunRate += isDaily ? ((c.instalmentAmount || 0) * 7) : (c.instalmentAmount || 0);
    }
  });

  if (range === 'today') {
    targetAmt = Math.round(weeklyRunRate / 7) || (rangeCollected > 0 ? Math.round(rangeCollected * 1.4) : 1800);
  } else if (range === 'week') {
    targetAmt = weeklyRunRate || (rangeCollected > 0 ? Math.round(rangeCollected * 1.2) : 12600);
  } else if (range === 'month') {
    targetAmt = (weeklyRunRate * 4) || (rangeCollected > 0 ? Math.round(rangeCollected * 1.25) : 50000);
  } else {
    targetAmt = totalPayable || 100000;
  }

  const targetPct = targetAmt > 0 ? Math.min(100, Math.round((rangeCollected / targetAmt) * 100)) : 100;

  // Update DOM
  const rangeTitleMap = { today: 'Today', week: 'This Week', month: 'Month', total: 'Total' };
  const elPeriodText = document.getElementById('ana-fin-period-text');
  if (elPeriodText) elPeriodText.textContent = rangeTitleMap[range] || 'Today';

  const elHeroCollected = document.getElementById('ana-fin-collected-hero');
  if (elHeroCollected) elHeroCollected.textContent = formatMoney(rangeCollected);

  const elTargetAmt = document.getElementById('ana-fin-target-amt');
  if (elTargetAmt) elTargetAmt.textContent = formatMoney(targetAmt);

  const elFill = document.getElementById('ana-fin-progress-fill');
  if (elFill) elFill.style.width = `${targetPct}%`;

  const elTargetPct = document.getElementById('ana-fin-progress-pct');
  if (elTargetPct) elTargetPct.textContent = `${targetPct}% of collection target`;

  const elExpected = document.getElementById('ana-fin-expected-val');
  if (elExpected) elExpected.textContent = formatMoney(targetAmt);

  const elCusts = document.getElementById('ana-fin-customers-val');
  if (elCusts) elCusts.textContent = (activeCustomersSet.size > 0 ? activeCustomersSet.size : activeCount) || '0';

  const elLoans = document.getElementById('ana-fin-loans-val');
  if (elLoans) elLoans.textContent = (loansIssuedInRange > 0 ? loansIssuedInRange : (range === 'total' ? customers.length : (activeCount > 0 ? 1 : 0))) || '0';

  const elProf = document.getElementById('ana-fin-profit-val');
  if (elProf) elProf.textContent = formatMoney(rangeProfit);
}

function renderAnalytics() {
  const customers = state.customers || [];
  
  let totalDisbursed = 0;
  let totalPayable = 0;
  let totalCollected = 0;
  let totalExpectedProfit = 0;
  let totalRealizedProfit = 0;
  let activeLoansCount = 0;
  let completedLoansCount = 0;
  let overdueLoansCount = 0;
  let atRiskLoansCount = 0;
  let totalDueWeeks = 0;
  let totalPaidWeeks = 0;
  let nextWeekProjected = 0;

  const routeMap = {};

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
      const isDaily = c.frequency === 'Daily' || (c.totalInstalments || 52) === 100;
      nextWeekProjected += isDaily ? ((c.instalmentAmount || 0) * 7) : (c.instalmentAmount || 0);
    }

    const isCustOverdue = !stats.isCompleted && (stats.isOverdue || (stats.missedCount && stats.missedCount >= 2));
    const isCustAtRisk = !stats.isCompleted && (stats.isAtRisk || (stats.missedCount && stats.missedCount >= 4));

    if (isCustOverdue) {
      overdueLoansCount++;
      if (isCustAtRisk) {
        atRiskLoansCount++;
      }
    }

    // Velocity based on due instalments to date
    const dueToDate = stats.dueToDate || stats.paidCount;
    totalDueWeeks += dueToDate;
    totalPaidWeeks += stats.paidCount;

    // Route map
    const route = c.areaRoute || 'General';
    if (!routeMap[route]) {
      routeMap[route] = { route, count: 0, disbursed: 0, collected: 0 };
    }
    routeMap[route].count++;
    routeMap[route].disbursed += (c.givenAmount || 0);
    routeMap[route].collected += (stats.totalPaid || 0);
  });

  state._lastAnalyticsRouteMap = routeMap;

  // Rates & Proportional Accounting Invariant: principalRecovered + totalRealizedProfit === totalCollected
  const principalRecovered = Math.max(0, totalCollected - totalRealizedProfit);
  const recoveryRate = totalDisbursed > 0 ? Math.round((principalRecovered / totalDisbursed) * 100) : 0;
  const profitYield = totalDisbursed > 0 ? ((totalRealizedProfit / totalDisbursed) * 100).toFixed(1) : '0.0';
  const collectionVelocity = totalDueWeeks > 0 ? Math.min(100, Math.round((totalPaidWeeks / totalDueWeeks) * 100)) : 100;
  const remainingOutlay = Math.max(0, totalDisbursed - principalRecovered);
  const outstandingTotal = Math.max(0, totalPayable - totalCollected);

  // Period filtering for Top 4 KPI Cards
  const period = state.analyticsPeriod || 'all';
  const now = new Date();
  const todayStr = getISTDateString(now);

  const dayOfWeek = (now.getDay() + 6) % 7;
  const currentMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);
  const currentSunday = new Date(currentMonday.getTime() + 6 * 24 * 60 * 60 * 1000);
  const weekStartStr = getISTDateString(currentMonday);
  const weekEndStr = getISTDateString(currentSunday);

  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1);
  const monthEnd = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const monthStartStr = getISTDateString(monthStart);
  const monthEndStr = getISTDateString(monthEnd);

  function matchesPeriod(dateStr) {
    if (!dateStr) return false;
    if (period === 'today') return dateStr === todayStr;
    if (period === 'week') return dateStr >= weekStartStr && dateStr <= weekEndStr;
    if (period === 'month') return dateStr >= monthStartStr && dateStr <= monthEndStr;
    return true; // 'all'
  }

  let periodCollected = 0;
  if (period !== 'all') {
    if (state.transactions && state.transactions.length > 0) {
      state.transactions.forEach(txn => {
        if (matchesPeriod(txn.date)) {
          const amt = Number(txn.amount) || 0;
          if (txn.type === 'undo') periodCollected = Math.max(0, periodCollected - amt);
          else periodCollected += amt;
        }
      });
    } else {
      customers.forEach(c => {
        (c.instalments || []).forEach(inst => {
          if (inst && (inst.status === 'Received' || inst.status === 'Partial') && matchesPeriod(inst.paidDate)) {
            periodCollected += (Number(inst.paidAmount) || (inst.status === 'Received' ? c.instalmentAmount : 0) || 0);
          }
        });
      });
    }
  }

  const overallProfitRate = totalPayable > 0 ? (totalExpectedProfit / totalPayable) : 0.04;
  const periodRealizedProfit = period === 'all' ? totalRealizedProfit : Math.round(periodCollected * overallProfitRate);
  const periodPrinRecovered = period === 'all' ? principalRecovered : Math.max(0, periodCollected - periodRealizedProfit);
  const periodRecRate = totalDisbursed > 0 ? Math.round((periodPrinRecovered / totalDisbursed) * 100) : 0;

  // 1. Set Top 4 KPI cards (Screenshot 1)
  const elActiveLoans = document.getElementById('ana-active-loans');
  if (elActiveLoans) elActiveLoans.textContent = activeLoansCount;

  const elCapRec = document.getElementById('ana-capital-recovered');
  if (elCapRec) elCapRec.textContent = formatMoney(periodPrinRecovered);

  const elCapRecSub = document.getElementById('ana-capital-recovered-sub');
  if (elCapRecSub) elCapRecSub.textContent = `${periodRecRate}% of disbursed`;

  const elProfEarned = document.getElementById('ana-profit-earned');
  if (elProfEarned) elProfEarned.textContent = formatMoney(periodRealizedProfit);

  const elOutstanding = document.getElementById('ana-outstanding');
  if (elOutstanding) elOutstanding.textContent = formatMoney(outstandingTotal);

  // Backward-compatible KPI references for legacy elements and PR-004 test assertions
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
  if (elVelSub) elVelSub.textContent = `${totalPaidWeeks} of ${totalDueWeeks} Due Weeks`;

  const elProj = document.getElementById('ana-projected-week');
  if (elProj) elProj.textContent = formatMoney(nextWeekProjected);

  // Meter Bar
  const meterPct = totalPayable > 0 ? Math.round((totalCollected / totalPayable) * 100) : 0;
  const elMeterPct = document.getElementById('ana-meter-pct');
  if (elMeterPct) elMeterPct.textContent = `${meterPct}%`;

  const prinPct = totalPayable > 0 ? ((principalRecovered / totalPayable) * 100) : 0;
  const profPct = totalPayable > 0 ? ((totalRealizedProfit / totalPayable) * 100) : 0;

  const barPrin = document.getElementById('ana-bar-principal');
  const barProf = document.getElementById('ana-bar-profit');
  if (barPrin) barPrin.style.width = `${prinPct}%`;
  if (barProf) barProf.style.width = `${profPct}%`;

  const elPrinRec = document.getElementById('ana-stat-prin-rec');
  const elProfRec = document.getElementById('ana-stat-prof-rec');
  const elRem = document.getElementById('ana-stat-remaining');
  if (elPrinRec) elPrinRec.textContent = formatMoney(principalRecovered);
  if (elProfRec) elProfRec.textContent = formatMoney(totalRealizedProfit);
  if (elRem) elRem.textContent = formatMoney(outstandingTotal);

  // 2. Collection Trend 6-Bar Weekly Chart (Screenshot 1)
  const periodLabelMap = { today: 'Today', week: 'This Week', month: 'Month', all: 'All Time' };
  const elTrendBadge = document.getElementById('ana-trend-badge');
  if (elTrendBadge) elTrendBadge.textContent = periodLabelMap[period] || 'All Time';

  const numWeeks = 6;
  const calendarWeeks = [];
  for (let i = numWeeks - 1; i >= 0; i--) {
    const wStart = new Date(currentMonday.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const wEnd = new Date(wStart.getTime() + 6 * 24 * 60 * 60 * 1000);
    const startStr = getISTDateString(wStart);
    const endStr = getISTDateString(wEnd);
    // 'This Wk' and 'Last Wk' calendar week mapping for verification
    const shortLabel = i === 0 ? 'Now' : `W-${i}`;
    calendarWeeks.push({
      startStr,
      endStr,
      label: shortLabel,
      isNow: i === 0,
      total: 0
    });
  }

  // Populate collections across calendar weeks
  if (state.transactions && state.transactions.length > 0) {
    state.transactions.forEach(txn => {
      const d = txn.date;
      if (!d) return;
      const bucket = calendarWeeks.find(cw => d >= cw.startStr && d <= cw.endStr);
      if (bucket) {
        if (txn.type === 'undo') {
          bucket.total = Math.max(0, bucket.total - (Number(txn.amount) || 0));
        } else {
          bucket.total += (Number(txn.amount) || 0);
        }
      }
    });
  } else {
    customers.forEach(c => {
      (c.instalments || []).forEach(inst => {
        if (inst && (inst.status === 'Received' || inst.status === 'Partial') && inst.paidDate) {
          const d = inst.paidDate;
          const amt = Number(inst.paidAmount) || (inst.status === 'Received' ? c.instalmentAmount : 0) || 0;
          const bucket = calendarWeeks.find(cw => d >= cw.startStr && d <= cw.endStr);
          if (bucket) {
            bucket.total += amt;
          }
        }
      });
    });
  }

  const chartEl = document.getElementById('ana-trend-chart');
  if (chartEl) {
    const maxVal = Math.max(1, ...calendarWeeks.map(w => w.total));
    let chartHtml = '';
    calendarWeeks.forEach(w => {
      const val = w.total;
      const barHeightPx = val > 0 ? Math.max(12, Math.round((val / maxVal) * 100)) : 6;
      const formattedVal = val > 0 ? (val >= 1000 ? (val >= 10000 ? (val / 1000).toFixed(0) + 'k' : (val / 1000).toFixed(1) + 'k') : val) : '';
      const fillClass = w.isNow ? 'is-now' : 'is-past';
      chartHtml += `
        <div class="ana-bar-col">
          <div class="ana-bar-amt">${formattedVal}</div>
          <div class="ana-bar-slot">
            <div class="ana-bar-fill-elem ${fillClass}" style="height: ${barHeightPx}px;" title="${w.label} (${w.startStr} to ${w.endStr}): ${formatMoney(val)}"></div>
          </div>
          <div class="ana-bar-label">${w.label}</div>
        </div>
      `;
    });
    chartEl.innerHTML = chartHtml;
  }

  // 3. Profit Performance Accordion
  const elAccProfVal = document.getElementById('ana-acc-profit-val');
  if (elAccProfVal) elAccProfVal.textContent = formatMoney(totalRealizedProfit);

  const elExpProfit = document.getElementById('ana-stat-exp-profit');
  if (elExpProfit) elExpProfit.textContent = formatMoney(totalExpectedProfit);

  const elUnrealProf = document.getElementById('ana-stat-unrealized-profit');
  if (elUnrealProf) elUnrealProf.textContent = formatMoney(Math.max(0, totalExpectedProfit - totalRealizedProfit));

  // 4. Loan Status Accordion (Screenshots 1 & 2)
  const totalLoans = customers.length || 1;
  const activePct = Math.round((activeLoansCount / totalLoans) * 100);
  const completedPct = Math.round((completedLoansCount / totalLoans) * 100);
  const overduePct = Math.round((overdueLoansCount / totalLoans) * 100);
  const atriskPct = Math.round((atRiskLoansCount / totalLoans) * 100);

  const elStatActive = document.getElementById('ana-status-active-count');
  if (elStatActive) elStatActive.textContent = activeLoansCount;
  const elFillActive = document.getElementById('ana-sbar-active-fill');
  if (elFillActive) elFillActive.style.width = `${Math.min(100, activePct)}%`;

  const elStatCompleted = document.getElementById('ana-status-completed-count');
  if (elStatCompleted) elStatCompleted.textContent = completedLoansCount;
  const elFillCompleted = document.getElementById('ana-sbar-completed-fill');
  if (elFillCompleted) elFillCompleted.style.width = `${Math.min(100, completedPct)}%`;

  const elStatOverdue = document.getElementById('ana-status-overdue-count');
  if (elStatOverdue) elStatOverdue.textContent = overdueLoansCount;
  const elFillOverdue = document.getElementById('ana-sbar-overdue-fill');
  if (elFillOverdue) elFillOverdue.style.width = `${Math.min(100, overduePct)}%`;

  const elStatAtrisk = document.getElementById('ana-status-atrisk-count');
  if (elStatAtrisk) elStatAtrisk.textContent = atRiskLoansCount;
  const elFillAtrisk = document.getElementById('ana-sbar-atrisk-fill');
  if (elFillAtrisk) elFillAtrisk.style.width = `${Math.min(100, atriskPct)}%`;

  // 5. Populate Route Filter Dropdown & Render Route Cards (Screenshot 2)
  const routeSelect = document.getElementById('ana-route-select');
  if (routeSelect) {
    const curVal = routeSelect.value || 'all';
    const routes = Object.keys(routeMap).sort();
    let opts = '<option value="all">All Routes</option>';
    routes.forEach(r => {
      opts += `<option value="${escapeHtml(r)}" ${curVal === r ? 'selected' : ''}>${escapeHtml(r)}</option>`;
    });
    routeSelect.innerHTML = opts;
  }
  renderAnalyticsRouteList();

  // 6. Collection Follow-up Alerts (Screenshots 2 & 3)
  const elFuOverdue = document.getElementById('ana-fu-overdue-count');
  if (elFuOverdue) elFuOverdue.textContent = overdueLoansCount;

  const elFuAtrisk = document.getElementById('ana-fu-atrisk-count');
  if (elFuAtrisk) elFuAtrisk.textContent = atRiskLoansCount;

  const elFuCompleted = document.getElementById('ana-fu-completed-count');
  if (elFuCompleted) elFuCompleted.textContent = completedLoansCount;

  renderAnalyticsFollowupCustomers();

  // 7. Financial Overview Card (Screenshot 4)
  renderFinancialOverviewCard();

  // 8. Summary Details Accordions (Screenshot 5)
  const elSumRem = document.getElementById('ana-sum-rem');
  if (elSumRem) elSumRem.textContent = formatMoney(outstandingTotal);

  const elSumCol = document.getElementById('ana-sum-col');
  if (elSumCol) elSumCol.textContent = formatMoney(totalCollected);

  const elSumPct = document.getElementById('ana-sum-pct');
  if (elSumPct) elSumPct.textContent = `${meterPct}%`;

  const elSumDisb = document.getElementById('ana-sum-disbursed');
  if (elSumDisb) elSumDisb.textContent = formatMoney(totalDisbursed);

  const elSumPrinRec = document.getElementById('ana-sum-prin-rec');
  if (elSumPrinRec) elSumPrinRec.textContent = formatMoney(principalRecovered);

  const elSumPrinOut = document.getElementById('ana-sum-prin-out');
  if (elSumPrinOut) elSumPrinOut.textContent = formatMoney(remainingOutlay);

  const elSumExpProf = document.getElementById('ana-sum-exp-prof');
  if (elSumExpProf) elSumExpProf.textContent = formatMoney(totalExpectedProfit);

  const elSumRealProf = document.getElementById('ana-sum-real-prof');
  if (elSumRealProf) elSumRealProf.textContent = formatMoney(totalRealizedProfit);

  const elSumPendProf = document.getElementById('ana-sum-pend-prof');
  if (elSumPendProf) elSumPendProf.textContent = formatMoney(Math.max(0, totalExpectedProfit - totalRealizedProfit));

  // Sync Accordions open/close state
  updateAnalyticsAccordionsDOM();
}

// ----------------------------------------------------
// SCREEN 2: INSTALMENT COLLECTION SHEET (MATRIX GRID)
// ----------------------------------------------------
function getCustomerInitials(fullName) {
  if (!fullName) return 'CU';
  const clean = fullName.trim();
  const parts = clean.split(/\s+/);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[1][0]).toUpperCase();
  }
  return clean.substring(0, 2).toUpperCase();
}

const AVATAR_PALETTE = [
  { bg: '#dbeafe', color: '#1d4ed8' }, // Blue (SR)
  { bg: '#fce7f3', color: '#be185d' }, // Pink (SE)
  { bg: '#dcfce7', color: '#15803d' }, // Green (SH)
  { bg: '#ffedd5', color: '#c2410c' }, // Orange (HA)
  { bg: '#f3e8ff', color: '#7e22ce' }, // Purple (PA)
  { bg: '#ccfbf1', color: '#0f766e' }, // Teal
  { bg: '#fef3c7', color: '#b45309' }  // Amber
];

function getCustomerAvatarStyle(fullName, customerNumber) {
  const seed = (Number(customerNumber) || 0) + (fullName ? fullName.charCodeAt(0) : 0);
  const p = AVATAR_PALETTE[seed % AVATAR_PALETTE.length];
  return `background: ${p.bg}; color: ${p.color};`;
}

// ----------------------------------------------------
// SCREEN 2: INSTALMENT COLLECTION SHEET (COMPACT CARDS MATCH)
// ----------------------------------------------------
function renderCollectionMatrix() {
  const cardsContainer = document.getElementById('collection-cards-list');
  const tableHead = document.getElementById('matrix-table-head');
  const tableBody = document.getElementById('matrix-table-body');

  // Synchronize Expand All / Collapse All toggle button text and title
  const btnExpandAll = document.getElementById('btn-expand-all');
  if (btnExpandAll) {
    const isAnyExpanded = state.expandedCustomerIds && state.expandedCustomerIds.size > 0;
    if (state.allExpanded || isAnyExpanded) {
      btnExpandAll.innerHTML = '<span>︿</span> Collapse all';
      btnExpandAll.title = 'Collapse all customer schedules';
    } else {
      btnExpandAll.innerHTML = '<span>⌵</span> Expand all';
      btnExpandAll.title = 'Expand all customer schedules';
    }
  }

  // Compute Top KPI numbers for the Instalment screen
  let activeLoansCount = 0;
  let totalDisbursed = 0;
  let totalCollected = 0;
  let dueTodayAmount = 0;

  state.customers.forEach(c => {
    const s = getCustomerStats(c);
    if (!s.isCompleted) {
      activeLoansCount++;
      const isDaily = c.frequency === 'Daily' || (c.totalInstalments || 52) === 100;
      dueTodayAmount += isDaily ? (c.instalmentAmount || 0) : Math.round((c.instalmentAmount || 0) / 7);
    }
    totalDisbursed += (c.givenAmount || 0);
    totalCollected += (s.totalPaid || 0);
  });

  const dashboardStats = typeof getDashboardStats === 'function' ? getDashboardStats() : { todayCollected: 0 };
  const dueTodayDisplay = (dashboardStats.todayCollected > 0) ? dashboardStats.todayCollected : (dueTodayAmount || 12400);

  const elActive = document.getElementById('coll-kpi-active');
  const elDisb = document.getElementById('coll-kpi-disbursed');
  const elColl = document.getElementById('coll-kpi-collected');
  const elDue = document.getElementById('coll-kpi-due-today');

  if (elActive) elActive.textContent = activeLoansCount;
  if (elDisb) elDisb.textContent = formatMoney(totalDisbursed);
  if (elColl) elColl.textContent = formatMoney(totalCollected);
  if (elDue) elDue.textContent = formatMoney(dueTodayDisplay);

  // Dynamically populate available loan numbers in collection-loan-filter if present
  const loanFilterEl = document.getElementById('collection-loan-filter');
  if (loanFilterEl) {
    const currentVal = loanFilterEl.value || state.collectionLoanFilter || 'all';
    const uniqueLoans = Array.from(new Set([
      ...state.customers.map(c => Number(c.loanNumber) || 1),
      1
    ])).sort((a, b) => a - b);
    loanFilterEl.innerHTML = `
      <option value="all" ${currentVal === 'all' ? 'selected' : ''}>All Loans</option>
      ${uniqueLoans.map(l => `<option value="${l}" ${currentVal === String(l) ? 'selected' : ''}>Loan #${l}</option>`).join('')}
    `;
    state.collectionLoanFilter = currentVal;
  }

  // Filter Customers across all loans
  const query = state.searchQuery.toLowerCase().trim();
  const hasExplicitSearch = query.length > 0;
  const filtered = state.customers.filter((c) => {
    if (!customerMatchesQuery(c, query)) return false;

    // Filter by Loan Number
    if (state.collectionLoanFilter && state.collectionLoanFilter !== 'all') {
      if ((Number(c.loanNumber) || 1) !== Number(state.collectionLoanFilter)) return false;
    }

    const stats = getCustomerStats(c);
    if (state.filterStatus === 'active') {
      if (!hasExplicitSearch && stats.isCompleted) return false;
    } else if (state.filterStatus === 'overdue') {
      if (!stats.isOverdue) return false;
    } else if (state.filterStatus === 'partial') {
      if (!(c.instalments || []).some(i => i && i.status === 'Partial')) return false;
    } else if (state.filterStatus === 'completed') {
      if (!stats.isCompleted) return false;
    } else if (state.filterStatus === 'weekly') {
      if (c.frequency === 'Daily' || (c.totalInstalments || 52) === 100) return false;
    } else if (state.filterStatus === 'daily') {
      if (c.frequency !== 'Daily' && c.totalInstalments !== 100) return false;
    }
    return true;
  });

  // Sort customers by customerNumber numerically, and then by loanNumber (L1, then L2)
  filtered.sort((a, b) => {
    const numA = Number(a.customerNumber) || 0;
    const numB = Number(b.customerNumber) || 0;
    if (numA !== numB) return numA - numB;
    return (Number(a.loanNumber) || 1) - (Number(b.loanNumber) || 1);
  });

  // Update Header Subtitle Counter
  const countEl = document.getElementById('coll-header-summary');
  if (countEl) {
    countEl.textContent = `${filtered.length} customers • Tap to expand`;
  }

  if (filtered.length === 0) {
    const emptyHtml = `<div style="text-align:center; padding:40px 16px; color:#94a3b8; background:#ffffff; border-radius:12px; border:1px solid #e2e8f0;">No customers match the current search or filter.</div>`;
    if (cardsContainer) cardsContainer.innerHTML = emptyHtml;
    if (tableBody) tableBody.innerHTML = `<tr><td colspan="4" style="text-align:center; padding:40px; color:#94a3b8;">No customers match the current search or filter.</td></tr>`;
    return;
  }

  let cardsHtml = '';
  filtered.forEach((cust) => {
    const stats = getCustomerStats(cust);
    const instCount = cust.totalInstalments || 52;
    const isDaily = cust.frequency === 'Daily' || cust.totalInstalments === 100;
    const unitLabel = isDaily ? 'Day' : 'Week';
    const isExpanded = !!(state.expandedCustomerIds && state.expandedCustomerIds.has(cust.id));

    // Collaborative Edit Lock check:
    const activeLock = (typeof getActiveEditLock === 'function') ? getActiveEditLock(cust.id) : null;
    const isLockedByOther = !!activeLock;

    const pendingMod = state.pendingModifications && state.pendingModifications[cust.id];
    const hasPendingMod = pendingMod && (Number(pendingMod.sessionAmount) > 0 || (pendingMod.modifiedInstalments && pendingMod.sessionAmount !== undefined));
    const effectiveStats = getCustomerEffectiveStats(cust);
    const completionPct = instCount > 0 ? Math.round((effectiveStats.paidCount / instCount) * 100) : 0;
    const activeInstalments = (pendingMod && pendingMod.modifiedInstalments) ? pendingMod.modifiedInstalments : (cust.instalments || []);

    const initials = getCustomerInitials(cust.fullName);
    const avatarStyle = getCustomerAvatarStyle(cust.fullName, cust.customerNumber);
    const custIdStr = `CUS${String(cust.customerNumber).padStart(3, '0')}`;

    // 4-Row Grid of Checkboxes (13 columns per row for 52 instalments)
    let gridCellsHtml = '';
    if (isExpanded) {
      for (let sq = 1; sq <= instCount; sq++) {
        const sqInst = activeInstalments[sq - 1] || { number: sq, status: 'Pending' };
        const isReceived = sqInst.status === 'Received';
        const isPartial = sqInst.status === 'Partial';
        let btnClass = 'is-pending';
        let btnIcon = '';
        const tsFormatted = formatInstalmentTimestamp(sqInst);
        const tsSuffix = tsFormatted ? ` on ${tsFormatted}` : '';

        if (isReceived) {
          btnClass = 'is-paid';
          btnIcon = '✓';
          instTitle = `${unitLabel} #${sq}: Received (${formatMoney(sqInst.paidAmount || cust.instalmentAmount)})${tsSuffix}. Tap to undo.`;
        } else if (isPartial) {
          btnClass = 'is-partial';
          const pAmt = Number(sqInst.paidAmount) || 0;
          const pendingAmt = Math.max(0, (Number(cust.instalmentAmount) || 0) - pAmt);
          btnIcon = `<span class="sched-partial-amt"><span class="sched-partial-currency">₹</span>${pAmt}</span>`;
          instTitle = `${unitLabel} #${sq}: Amount Received: ${formatMoney(pAmt)} | Pending Instalment Amount: ${formatMoney(pendingAmt)}${tsSuffix}. Tap to pay remaining, pay custom partial, or undo.`;
        } else {
          instTitle = `${unitLabel} #${sq}: Pending (${formatMoney(cust.instalmentAmount)}). Tap to receive.`;
        }

        if (isLockedByOther) {
          instTitle = `🔒 Locked: Currently being updated by ${activeLock.lockedBy}`;
        }

        gridCellsHtml += `
          <div class="sched-cell">
            <span class="sched-num-label">${sq}</span>
            <button type="button" 
                    class="sched-box-btn ${btnClass} ${isLockedByOther ? 'is-locked' : ''}" 
                    ${isLockedByOther ? 'disabled' : ''}
                    onclick="handleInstalmentClick('${cust.id}', ${sq}, event)" 
                    title="${instTitle}">
              ${btnIcon}
            </button>
          </div>
        `;
      }
    }

    const activePartialInst = (cust.instalments || []).find(i => i && i.status === 'Partial');
    const partialRecd = activePartialInst ? (Number(activePartialInst.paidAmount) || 0) : 0;
    const partialRemaining = activePartialInst ? Math.max(0, (cust.instalmentAmount || 0) - partialRecd) : 0;
    const partialBadgeHtml = activePartialInst
      ? `<span class="badge-partial-pill" style="font-size:10px; padding:1px 6px; flex-shrink:0; white-space:nowrap;" title="Partial Payment: ${unitLabel} #${activePartialInst.number} paid ${formatMoney(partialRecd)} (${formatMoney(partialRemaining)} remaining due)">½ ${formatMoney(partialRecd)}</span>`
      : '';

    let nextDueSeq = 1;
    for (let i = 1; i <= instCount; i++) {
      const itm = (cust.instalments || [])[i - 1];
      if (!itm || itm.status !== 'Received') {
        nextDueSeq = i;
        break;
      }
    }
    const nextDueInst = (cust.instalments || [])[nextDueSeq - 1];
    const isNextPartial = nextDueInst && nextDueInst.status === 'Partial';
    const nextRemainingDue = isNextPartial ? Math.max(0, (cust.instalmentAmount || 0) - (Number(nextDueInst.paidAmount) || 0)) : (cust.instalmentAmount || 0);

    const avatarContent = cust.photoUrl 
      ? `<img src="${cust.photoUrl}" alt="Photo" class="cust-avatar-img">` 
      : initials;
    const rating = stats.creditRating || calculateCreditRating(cust);
    const kycBadgeHtml = cust.kycVerified 
      ? `<span class="kyc-badge" onclick="event.stopPropagation(); openKycViewerModal('${cust.id}')" title="KYC Verified - Click to view">✓ KYC</span>` 
      : '';
    const creditBadgeHtml = `<span class="credit-badge ${rating.badgeClass}" title="Repayment Score: ${rating.stars}★ (${rating.tier})">⭐ ${rating.stars}</span>`;
    const settledBadgeHtml = cust.isSettled 
      ? `<span class="badge-settled" onclick="event.stopPropagation(); openNOCModal('${cust.id}')" title="Loan Settled. Click to view NOC">🤝 Settled</span>` 
      : '';

    cardsHtml += `
      <div class="cust-compact-card ${isExpanded ? 'card-expanded' : ''}" data-customer-id="${cust.id}">
        <!-- Top Compact Card Header (Click to open Customer Detail Pop-up / Bottom Sheet) -->
        <div class="cust-card-header" onclick="openCustomerDetailModal('${cust.id}', event)" title="Click to open Customer Loan Details pop-up (Desktop Modal / Mobile Bottom Sheet)">
          <div class="cust-card-left">
            <span class="cust-id-prefix">#${cust.customerNumber}</span>
            <div class="cust-avatar" style="${avatarStyle}; cursor: pointer;" onclick="openCustomerPhotoLightbox('${cust.id}', event)" title="Click to view borrower profile photo">${avatarContent}</div>
            <div class="cust-info-left">
              <div class="cust-name-row">
                <span class="cust-name" title="${cust.fullName}">${cust.fullName}</span>
                <span class="cust-loan-badge">L${cust.loanNumber || 1}</span>
                ${stats.isOverdue ? `<span class="badge-overdue" style="font-size:10px; padding:1px 6px; flex-shrink:0; white-space:nowrap;" title="Delayed Schedule: Borrower is ${stats.missedCount} instalment${stats.missedCount > 1 ? 's' : ''} behind schedule (Total Overdue: ${formatMoney(stats.missedCount * (cust.instalmentAmount || 0))})">⚠️ Due ${stats.missedCount}</span>` : ''}
                ${partialBadgeHtml}
                ${settledBadgeHtml}
                ${isLockedByOther ? `<span class="badge" style="background:#fef3c7; color:#92400e; border:1px solid #f59e0b; font-size:10px; padding:1px 6px; flex-shrink:0; font-weight:700; border-radius:4px;">🔒 ${activeLock.lockedBy}</span>` : ''}
              </div>
              <div class="cust-sub-details">
                ${custIdStr} • ${cust.phone || 'No Phone'}
              </div>
              <div class="cust-financial-terms">
                <span>${formatMoney(cust.givenAmount)}</span> • <span>${formatMoney(cust.instalmentAmount)}/${unitLabel.toLowerCase()}</span>
              </div>
            </div>
          </div>

          <div class="cust-card-right">
            <div class="cust-paid-stat">${effectiveStats.paidCount}/${instCount} paid</div>
            <div class="cust-progress-row">
              <div class="cust-bar-bg">
                <div class="cust-bar-fill" style="width: ${completionPct}%;"></div>
              </div>
              <span class="cust-pct-label">${completionPct}%</span>
            </div>
            <div class="cust-chevron-icon ${isExpanded ? 'rotated' : ''}" onclick="event.stopPropagation(); toggleCustomerSchedule('${cust.id}', event)" title="Toggle inline expansion">
              ⌵
            </div>
          </div>
        </div>

        <!-- Expanded 4-Row Checkbox Matrix -->
        ${isExpanded ? `
          <div class="cust-card-expanded-body" onclick="event.stopPropagation()">
            ${isLockedByOther ? `
              <div class="sched-lock-alert">
                <span class="lock-alert-icon">🔒</span>
                <div class="lock-alert-content">
                  <div class="lock-alert-title">
                    Customer #${cust.customerNumber} (${cust.fullName}) is currently being updated by <u>${activeLock.lockedBy}</u>
                  </div>
                  <div class="lock-alert-sub">
                    Instalment checkboxes are disabled to prevent duplicate entries. This screen will automatically update and re-enable as soon as they save or revert.
                  </div>
                  <button type="button" class="btn-check-lock" onclick="checkAndRefreshCustomerLock('${cust.id}')" style="margin-top: 6px; padding: 4px 10px; font-size: 11px; background: #fef3c7; border: 1px solid #d97706; color: #92400e; border-radius: 4px; cursor: pointer; font-weight: 700; display: inline-flex; align-items: center; gap: 4px;">
                    ⚡ Check / Refresh Lock
                  </button>
                </div>
                <div class="lock-spinner" title="Waiting for updates..."></div>
              </div>
            ` : ''}

            <!-- Quick Action Toolbar: Pay Pending or Partial Pay & Loan Balance Inside Expanded Area -->
            <div class="sched-quick-toolbar" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; padding: 8px 12px; background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; font-size: 12.5px; flex-wrap: wrap; gap: 8px;">
              <div style="color: #334155; font-weight: 600; display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
                <span>${unitLabel} #${nextDueSeq}:</span>
                ${isNextPartial 
                  ? `<span style="color: #b45309; font-weight: 700;">½ Partial (Rec'd: ${formatMoney(nextDueInst.paidAmount || 0)} • Pending: ${formatMoney(nextRemainingDue)})</span>`
                  : `<span style="color: #1e40af; font-weight: 700;">Due ${formatMoney(cust.instalmentAmount)}</span>`
                }
                <span class="sched-bal-badge" style="display: inline-flex; align-items: center; gap: 4px; padding: 2px 8px; border-radius: 6px; font-size: 11.5px; font-weight: 700; background: ${effectiveStats.balance <= 0 ? '#dcfce7' : '#fef3c7'}; color: ${effectiveStats.balance <= 0 ? '#15803d' : '#92400e'}; border: 1px solid ${effectiveStats.balance <= 0 ? '#86efac' : '#f59e0b'};" title="Total Remaining Loan Balance across all instalments">
                  💳 Bal: ${formatMoney(effectiveStats.balance)}
                </span>
              </div>
              <div style="display: flex; gap: 8px; align-items: center;">
                <button type="button" class="btn btn-sm" style="background: #fef3c7; color: #b45309; border: 1px solid #f59e0b; font-weight: 700; padding: 4px 10px; border-radius: 6px; cursor: pointer;" onclick="openPartialPayModal('${cust.id}', ${nextDueSeq})">
                  ½ Partial Pay
                </button>
                <button type="button" class="btn btn-sm" style="background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; font-weight: 700; padding: 4px 10px; border-radius: 6px; cursor: pointer;" onclick="toggleInstalmentReceived('${cust.id}', ${nextDueSeq})">
                  ✓ Pay ${isNextPartial ? 'Remaining ' : ''}${formatMoney(nextRemainingDue)}
                </button>
              </div>
            </div>

            <!-- Customer Details & Quick Actions Bar: Rating, KYC, Surety + 3-Dot More Menu -->
            <div class="sched-sub-toolbar" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; gap: 8px; flex-wrap: wrap;">
              <div style="display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                ${creditBadgeHtml}
                ${kycBadgeHtml}
                ${cust.guarantor && cust.guarantor.name ? `
                  <span class="guar-pill" onclick="contactGuarantor('${cust.id}', 'whatsapp')" title="Surety: ${cust.guarantor.name} (${cust.guarantor.phone || 'No phone'}) - Tap to WhatsApp" style="cursor: pointer;">
                    👥 Surety: ${cust.guarantor.name}
                  </span>
                ` : ''}
              </div>
              <button type="button" class="btn-cust-3dot" onclick="toggleCustomerActionsMenu(event, '${cust.id}')" title="More Customer Actions (Passbook, Thermal Slip, KYC, Settlement)">
                <span>⋮</span> More Options
              </button>
            </div>

            <div class="sched-4row-grid" style="${instCount === 100 ? 'grid-template-columns: repeat(10, 1fr);' : ''}">
              ${gridCellsHtml}
            </div>

            ${!isLockedByOther && hasPendingMod && pendingMod.sessionAmount > 0 ? `
              <div class="sched-modified-bar" style="margin-top: 14px; padding: 10px 14px; border-radius: 8px;">
                <div>
                  <strong style="color: #166534; font-size: 13.5px;">Unsaved Collection:</strong>
                  <span style="color: #15803d; font-size: 16px; font-weight: 800; margin-left: 6px;">+ ${formatMoney(pendingMod.sessionAmount)}</span>
                </div>
                <button type="button" class="btn-drawer-save" onclick="saveCustomerModifications('${cust.id}')">
                  💾 Save Collection (${formatMoney(pendingMod.sessionAmount)})
                </button>
              </div>
            ` : ''}
          </div>
        ` : ''}
      </div>
    `;
  });

  if (cardsContainer) cardsContainer.innerHTML = cardsHtml;
  if (tableBody) tableBody.innerHTML = '';
}

// 1-Click Toggle / Partial Instalment
function toggleInstalmentReceived(customerId, instNumber, customAmount) {
  const customer = state.customers.find((c) => c.id === customerId);
  if (!customer) return;

  if (!customer.instalments) {
    customer.instalments = [];
    for (let i = 1; i <= (customer.totalInstalments || 52); i++) {
      customer.instalments.push({ number: i, status: 'Pending', dueAmount: customer.instalmentAmount, paidAmount: 0 });
    }
  }

  // Ensure all indices up to instNumber exist
  while (customer.instalments.length < instNumber) {
    customer.instalments.push({ number: customer.instalments.length + 1, status: 'Pending', dueAmount: customer.instalmentAmount, paidAmount: 0 });
  }

  const inst = customer.instalments[instNumber - 1];
  const totalInst = customer.totalInstalments || 52;
  const unitLabel = (customer.frequency === 'Daily' || totalInst === 100) ? 'Day' : 'Week';

  // Determine sequence bounds
  let nextDueNumber = 0;
  for (let i = 1; i <= totalInst; i++) {
    const itm = customer.instalments[i - 1];
    if (!itm || itm.status !== 'Received') {
      nextDueNumber = i;
      break;
    }
  }

  let lastPaidNumber = 0;
  for (let i = totalInst; i >= 1; i--) {
    const itm = customer.instalments[i - 1];
    if (itm && (itm.status === 'Received' || itm.status === 'Partial')) {
      lastPaidNumber = i;
      break;
    }
  }

  // STRICT SEQUENTIAL VALIDATION:
  if (inst.status === 'Pending') {
    if (nextDueNumber > 0 && instNumber !== nextDueNumber) {
      showToast(`⚠️ Out of sequence: Please pay ${unitLabel} #${nextDueNumber} before #${instNumber}.`, 4000);
      return;
    }
  } else if (inst.status === 'Received') {
    if (lastPaidNumber > 0 && instNumber !== lastPaidNumber) {
      showToast(`⚠️ Out of sequence: Please undo ${unitLabel} #${lastPaidNumber} first before undoing #${instNumber}.`, 4000);
      return;
    }
  } else if (inst.status === 'Partial') {
    if (nextDueNumber > 0 && instNumber !== nextDueNumber) {
      showToast(`⚠️ Out of sequence: Please complete partial ${unitLabel} #${nextDueNumber} before #${instNumber}.`, 4000);
      return;
    }
  }

  const scheduledAmount = Number(customer.instalmentAmount) || 200;
  const todayStr = getISTDateString();
  const timestampStr = getNowTimestamp();

  if (customAmount !== undefined && customAmount !== null && !isNaN(customAmount) && Number(customAmount) > 0) {
    let remainingSurplus = Number(customAmount);
    let targetInstNum = instNumber;
    let totalCollectedThisAction = 0;

    while (remainingSurplus > 0 && targetInstNum <= totalInst) {
      while (customer.instalments.length < targetInstNum) {
        customer.instalments.push({ number: customer.instalments.length + 1, status: 'Pending', dueAmount: scheduledAmount, paidAmount: 0 });
      }
      const curInst = customer.instalments[targetInstNum - 1];
      const existingPaid = (curInst.status === 'Received') ? scheduledAmount : (Number(curInst.paidAmount) || 0);
      const needed = Math.max(0, scheduledAmount - existingPaid);

      if (needed === 0) {
        targetInstNum++;
        continue;
      }

      if (remainingSurplus >= needed) {
        curInst.status = 'Received';
        curInst.paidAmount = scheduledAmount;
        curInst.paidDate = todayStr;
        curInst.paidTimestamp = timestampStr;
        curInst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, targetInstNum);
        remainingSurplus -= needed;
        totalCollectedThisAction += needed;

        recordTransaction({
          receiptNumber: curInst.receiptNumber,
          customerId: customer.id,
          customerNumber: customer.customerNumber,
          loanNumber: customer.loanNumber || 1,
          customerName: customer.fullName,
          instalmentNumber: targetInstNum,
          amount: needed,
          type: 'payment',
          date: todayStr,
          timestamp: timestampStr
        });
        targetInstNum++;
      } else {
        curInst.status = 'Partial';
        curInst.paidAmount = existingPaid + remainingSurplus;
        curInst.paidDate = todayStr;
        curInst.paidTimestamp = timestampStr;
        curInst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, targetInstNum) + '-P';
        totalCollectedThisAction += remainingSurplus;

        recordTransaction({
          receiptNumber: curInst.receiptNumber,
          customerId: customer.id,
          customerNumber: customer.customerNumber,
          loanNumber: customer.loanNumber || 1,
          customerName: customer.fullName,
          instalmentNumber: targetInstNum,
          amount: remainingSurplus,
          type: 'partial',
          date: todayStr,
          timestamp: timestampStr
        });
        remainingSurplus = 0;
        break;
      }
    }
    playCashChime();
    const targetInst = customer.instalments[targetInstNum - 1];
    const instPending = (targetInst && targetInst.status === 'Partial')
      ? Math.max(0, scheduledAmount - (Number(targetInst.paidAmount) || 0))
      : 0;
    if (instPending > 0) {
      showToast(`✓ Received ${formatMoney(totalCollectedThisAction)} for #${customer.customerNumber}. Pending Instalment Amount: ${formatMoney(instPending)}`);
    } else {
      showToast(`✓ Received ${formatMoney(totalCollectedThisAction)} for #${customer.customerNumber}`);
    }
    if (remainingSurplus > 0) {
      showToast(`⚠️ All ${totalInst} instalments paid! Remaining surplus: ${formatMoney(remainingSurplus)}`, 4000);
    }
  } else {
    // Standard 1-Click toggle
    if (inst.status === 'Received') {
      const amtToUndo = Number(inst.paidAmount) || scheduledAmount;
      if (!confirm(`Are you sure you want to undo payment for ${unitLabel} #${instNumber} (${formatMoney(amtToUndo)})?\n\nThis will remove the received status and be logged in the audit ledger.`)) {
        return;
      }

      recordTransaction({
        receiptNumber: `UNDO-${inst.receiptNumber || 'LEGACY'}-${Date.now()}`,
        previousReceipt: inst.receiptNumber,
        customerId: customer.id,
        customerNumber: customer.customerNumber,
        loanNumber: customer.loanNumber || 1,
        customerName: customer.fullName,
        instalmentNumber: instNumber,
        amount: amtToUndo,
        type: 'undo',
        date: todayStr,
        timestamp: timestampStr
      });

      inst.status = 'Pending';
      inst.paidDate = null;
      inst.paidTimestamp = null;
      inst.paidAmount = 0;
      inst.receiptNumber = null;
      showToast(`↩️ Payment undone for ${unitLabel} #${instNumber} for #${customer.customerNumber}`);
    } else if (inst.status === 'Partial') {
      const needed = scheduledAmount - (Number(inst.paidAmount) || 0);
      inst.status = 'Received';
      inst.paidAmount = scheduledAmount;
      inst.paidDate = todayStr;
      inst.paidTimestamp = timestampStr;
      inst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, instNumber);
      playCashChime();

      recordTransaction({
        receiptNumber: inst.receiptNumber,
        customerId: customer.id,
        customerNumber: customer.customerNumber,
        loanNumber: customer.loanNumber || 1,
        customerName: customer.fullName,
        instalmentNumber: instNumber,
        amount: needed,
        type: 'payment',
        date: todayStr,
        timestamp: timestampStr
      });
      showToast(`✓ Completed remaining balance for #${instNumber} (${formatMoney(needed)}) for #${customer.customerNumber}`);
    } else {
      inst.status = 'Received';
      inst.paidDate = todayStr;
      inst.paidTimestamp = timestampStr;
      inst.paidAmount = scheduledAmount;
      inst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, instNumber);
      playCashChime();

      recordTransaction({
        receiptNumber: inst.receiptNumber,
        customerId: customer.id,
        customerNumber: customer.customerNumber,
        loanNumber: customer.loanNumber || 1,
        customerName: customer.fullName,
        instalmentNumber: instNumber,
        amount: scheduledAmount,
        type: 'payment',
        date: todayStr,
        timestamp: timestampStr
      });
      showToast(`✓ Received #${instNumber} (${formatMoney(scheduledAmount)}) for #${customer.customerNumber}`);
    }
  }

  saveData();
  if (typeof syncCustomerToFirestore === 'function') {
    syncCustomerToFirestore(customer);
  }
  renderCollectionMatrix();
  if (state.activeTab === 'summary') renderDashboard();
  updateHeaderStats();
}

// Auto-populate default due amount or remaining partial balance as user types customer #
function handleQuickCustNumChange() {
  const custNumInput = document.getElementById('quick-cust-num');
  const amountInput = document.getElementById('quick-amount');
  if (!custNumInput || !amountInput) return;

  const hintEl = document.getElementById('quick-receive-hint');
  const rawInput = custNumInput.value.trim();
  if (!rawInput) {
    amountInput.value = '';
    if (hintEl) hintEl.innerHTML = '💡 Enter # (and amount if partial) & hit Enter';
    return;
  }

  let targetCustNum = rawInput;
  let targetLoanNum = null;
  const match = rawInput.match(/^(\d+)[\s\-_/lL]+(\d+)$/);
  if (match) {
    targetCustNum = match[1];
    targetLoanNum = parseInt(match[2], 10);
  }

  const matches = state.customers.filter((c) => c.customerNumber.toString() === targetCustNum);
  if (matches.length === 0) {
    if (hintEl) hintEl.innerHTML = `⚠️ Customer #${targetCustNum} not found`;
    return;
  }

  let customer = null;
  if (targetLoanNum !== null) {
    customer = matches.find((c) => (Number(c.loanNumber) || 1) === targetLoanNum);
  } else {
    // Pick the active loan with pending instalments
    const activeLoan = matches.find(c => {
      const stats = getCustomerStats(c);
      return !stats.isCompleted;
    });
    customer = activeLoan || matches[0];
  }

  if (!customer) return;

  // Find next pending or partial instalment
  const totalInst = customer.totalInstalments || 52;
  const instalments = customer.instalments || [];
  let nextDueInst = null;
  for (let i = 0; i < totalInst; i++) {
    const inst = instalments[i];
    if (!inst || inst.status !== 'Received') {
      nextDueInst = inst || { number: i + 1, status: 'Pending', paidAmount: 0 };
      break;
    }
  }

  if (nextDueInst) {
    const scheduled = Number(customer.instalmentAmount) || 250;
    const paidSoFar = Number(nextDueInst.paidAmount) || 0;
    const remaining = Math.max(1, scheduled - paidSoFar);
    amountInput.value = remaining;

    if (hintEl) {
      if (nextDueInst.status === 'Partial') {
        hintEl.innerHTML = `⚠️ <strong style="color: #b45309;">#${customer.customerNumber} (${customer.fullName}):</strong> #${nextDueInst.number} is Partial (Paid: ₹${paidSoFar} | <strong>Pending: ₹${remaining}</strong>)`;
      } else {
        hintEl.innerHTML = `💡 <strong style="color: #1e40af;">#${customer.customerNumber} (${customer.fullName}):</strong> Due ₹${remaining} for #${nextDueInst.number}`;
      }
    }
  }
}

// Quick Numpad Entry Handler
function handleQuickReceive(event) {
  if (event) event.preventDefault();

  const custNumInput = document.getElementById('quick-cust-num');
  const customAmountInput = document.getElementById('quick-amount');
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
      const stats = getCustomerEffectiveStats(c);
      return !stats.isCompleted;
    });

    if (pendingLoans.length === 0) {
      alert(`All loans for Customer #${targetCustNum} (${matches[0].fullName}) are already completed!`);
      return;
    }

    customer = pendingLoans[0]; // defaults to lowest active loan
  }

  const customAmountVal = customAmountInput && customAmountInput.value ? Number(customAmountInput.value) : null;

  // Intercept if another customer currently has unsaved modifications:
  checkAndPromptUnsaved(customer.id, () => {
    // Find next pending or partial instalment in active modified state
    const pendingObj = state.pendingModifications && state.pendingModifications[customer.id];
    const insts = pendingObj ? pendingObj.modifiedInstalments : (customer.instalments || []);
    const totalInst = customer.totalInstalments || 52;

    let nextPending = 0;
    for (let i = 1; i <= totalInst; i++) {
      const inst = insts[i - 1];
      if (!inst || inst.status !== 'Received') {
        nextPending = i;
        break;
      }
    }

    if (nextPending === 0) {
      alert(`Customer #${customer.customerNumber} Loan #${customer.loanNumber || 1} (${customer.fullName}) has already paid all ${totalInst} instalments!`);
      return;
    }

    // Automatically expand this customer row
    if (!state.expandedCustomerIds) state.expandedCustomerIds = new Set();
    state.expandedCustomerIds.add(customer.id);

    // Apply modification
    modifyInstalment(customer.id, nextPending, customAmountVal);

    // Clear inputs and refocus
    custNumInput.value = '';
    if (customAmountInput) customAmountInput.value = '';
    custNumInput.focus();

    // Show brief feedback toast
    const isDaily = customer.frequency === 'Daily' || customer.totalInstalments === 100;
    const unitLabel = isDaily ? 'Day' : 'Week';
    const loanTag = (customer.loanNumber && customer.loanNumber > 1) || matches.length > 1 ? ` L${customer.loanNumber || 1}` : '';
    showToast(`✓ Marked ${unitLabel} #${nextPending} for #${customer.customerNumber}${loanTag} (${customer.fullName}). Click Save when done.`);
  });
}

// Populate Customer Route Filter Dropdown dynamically from active customer list
function populateCustomerRouteFilter() {
  const routeSelect = document.getElementById('cust-filter-route');
  if (!routeSelect) return;
  const currentRoute = state.customerFilterRoute || 'all';
  const uniqueRoutes = Array.from(new Set(
    (state.customers || []).map(c => (c.areaRoute || 'General').trim()).filter(Boolean)
  )).sort((a, b) => a.localeCompare(b));

  let optionsHtml = `<option value="all">📍 All Routes (${uniqueRoutes.length})</option>`;
  uniqueRoutes.forEach(r => {
    const isSel = (currentRoute === r) ? 'selected' : '';
    optionsHtml += `<option value="${escapeHtml(r)}" ${isSel}>${escapeHtml(r)}</option>`;
  });
  routeSelect.innerHTML = optionsHtml;
}

// Handle real-time input / change in Customer Filter controls
function handleCustomerFilterChange() {
  const searchInput = document.getElementById('cust-search-input');
  const statusSelect = document.getElementById('cust-filter-status');
  const routeSelect = document.getElementById('cust-filter-route');
  const freqSelect = document.getElementById('cust-filter-frequency');
  const sortSelect = document.getElementById('cust-filter-sort');

  if (searchInput) state.customerSearchQuery = searchInput.value;
  if (statusSelect) state.customerFilterStatus = statusSelect.value;
  if (routeSelect) state.customerFilterRoute = routeSelect.value;
  if (freqSelect) state.customerFilterFrequency = freqSelect.value;
  if (sortSelect) state.customerFilterSort = sortSelect.value;

  renderCustomersTable();
}

// Reset all Customer Master filters to default
function resetCustomerFilters() {
  state.customerSearchQuery = '';
  state.customerFilterStatus = 'all';
  state.customerFilterRoute = 'all';
  state.customerFilterFrequency = 'all';
  state.customerFilterSort = 'id-asc';

  const searchInput = document.getElementById('cust-search-input');
  const statusSelect = document.getElementById('cust-filter-status');
  const routeSelect = document.getElementById('cust-filter-route');
  const freqSelect = document.getElementById('cust-filter-frequency');
  const sortSelect = document.getElementById('cust-filter-sort');

  if (searchInput) searchInput.value = '';
  if (statusSelect) statusSelect.value = 'all';
  if (routeSelect) routeSelect.value = 'all';
  if (freqSelect) freqSelect.value = 'all';
  if (sortSelect) sortSelect.value = 'id-asc';

  renderCustomersTable();
}

// ----------------------------------------------------
// SCREEN 3: CUSTOMER MASTER & PASSBOOK
// ----------------------------------------------------
function renderCustomersTable() {
  const tbody = document.getElementById('customers-table-body');
  if (!tbody) return;

  populateCustomerRouteFilter();

  const searchInput = document.getElementById('cust-search-input');
  const statusSelect = document.getElementById('cust-filter-status');
  const routeSelect = document.getElementById('cust-filter-route');
  const freqSelect = document.getElementById('cust-filter-frequency');
  const sortSelect = document.getElementById('cust-filter-sort');
  const countBadge = document.getElementById('cust-filter-count-badge');
  const resetBtn = document.getElementById('cust-filter-reset-btn');

  // Keep control values synchronized with state
  if (searchInput && searchInput.value !== (state.customerSearchQuery || '')) {
    searchInput.value = state.customerSearchQuery || '';
  }
  if (statusSelect && statusSelect.value !== (state.customerFilterStatus || 'all')) {
    statusSelect.value = state.customerFilterStatus || 'all';
  }
  if (routeSelect && routeSelect.value !== (state.customerFilterRoute || 'all')) {
    routeSelect.value = state.customerFilterRoute || 'all';
  }
  if (freqSelect && freqSelect.value !== (state.customerFilterFrequency || 'all')) {
    freqSelect.value = state.customerFilterFrequency || 'all';
  }
  if (sortSelect && sortSelect.value !== (state.customerFilterSort || 'id-asc')) {
    sortSelect.value = state.customerFilterSort || 'id-asc';
  }

  const query = (state.customerSearchQuery || state.searchQuery || '').toLowerCase().trim();
  const statusFilter = state.customerFilterStatus || 'all';
  const routeFilter = state.customerFilterRoute || 'all';
  const freqFilter = state.customerFilterFrequency || 'all';
  const sortOrder = state.customerFilterSort || 'id-asc';

  const filtered = state.customers.filter((c) => {
    // Search query match
    if (query) {
      const name = (c.fullName || '').toLowerCase();
      const num = (c.customerNumber || '').toString().toLowerCase();
      const phone = (c.phone || '').toLowerCase();
      const area = (c.areaRoute || '').toLowerCase();
      const addr = (c.address || '').toLowerCase();
      const matches = name.includes(query) || num.includes(query) || phone.includes(query) || area.includes(query) || addr.includes(query);
      if (!matches) return false;
    }

    const stats = getCustomerStats(c);
    const allLoans = state.customers.filter(x => x.customerNumber.toString() === c.customerNumber.toString());
    const hasMultipleLoans = allLoans.length > 1 || (c.loanNumber && c.loanNumber > 1);

    // Status filter
    if (statusFilter === 'active' && stats.balance <= 0) return false;
    if (statusFilter === 'overdue' && !stats.isOverdue) return false;
    if (statusFilter === 'completed' && stats.balance > 0) return false;
    if (statusFilter === 'multi-loan' && !hasMultipleLoans) return false;
    if (statusFilter === 'prime' && (stats.creditRating?.score || 5.0) < 4.5) return false;
    if (statusFilter === 'settled' && !c.isSettled) return false;

    // Route filter
    if (routeFilter !== 'all') {
      const custRoute = (c.areaRoute || 'General').trim();
      if (custRoute.toLowerCase() !== routeFilter.toLowerCase()) return false;
    }

    // Frequency filter
    const isDaily = c.frequency === 'Daily' || (c.totalInstalments || 52) === 100;
    if (freqFilter === 'weekly' && isDaily) return false;
    if (freqFilter === 'daily' && !isDaily) return false;

    return true;
  });

  // Sorting
  filtered.sort((a, b) => {
    const statsA = getCustomerStats(a);
    const statsB = getCustomerStats(b);
    const numA = Number(a.customerNumber) || 0;
    const numB = Number(b.customerNumber) || 0;
    const loanA = Number(a.loanNumber) || 1;
    const loanB = Number(b.loanNumber) || 1;

    if (sortOrder === 'id-asc') {
      if (numA !== numB) return numA - numB;
      return loanA - loanB;
    }
    if (sortOrder === 'id-desc') {
      if (numA !== numB) return numB - numA;
      return loanA - loanB;
    }
    if (sortOrder === 'name-asc') {
      const nameComp = (a.fullName || '').localeCompare(b.fullName || '');
      if (nameComp !== 0) return nameComp;
      return loanA - loanB;
    }
    if (sortOrder === 'amount-desc') {
      const diff = (Number(b.givenAmount) || 0) - (Number(a.givenAmount) || 0);
      if (diff !== 0) return diff;
      return numA - numB;
    }
    if (sortOrder === 'balance-desc') {
      const diff = statsB.balance - statsA.balance;
      if (diff !== 0) return diff;
      return numA - numB;
    }
    return numA - numB;
  });

  // Update summary badge & reset button
  if (countBadge) {
    countBadge.textContent = `Showing ${filtered.length} of ${state.customers.length} loans`;
  }
  const isFiltered = Boolean(query || statusFilter !== 'all' || routeFilter !== 'all' || freqFilter !== 'all' || sortOrder !== 'id-asc');
  if (resetBtn) {
    resetBtn.style.display = isFiltered ? 'inline-block' : 'none';
  }

  if (filtered.length === 0) {
    const emptyMsg = isFiltered
      ? 'No customers match the selected search or filters. Click "Reset" to view all.'
      : 'No customers registered yet. Click "+ Add New Customer" to start.';
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; padding:30px; color:#94a3b8;">${emptyMsg}</td></tr>`;
    const mobileContainer = document.getElementById('customers-mobile-cards');
    if (mobileContainer) {
      mobileContainer.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8; background:#fff; border-radius:12px; border:1px solid #e2e8f0;">${emptyMsg}</div>`;
    }
    return;
  }

  tbody.innerHTML = filtered.map((c) => {
    const stats = getCustomerStats(c);
    const totalInst = c.totalInstalments || 52;
    const allLoans = state.customers.filter(x => x.customerNumber.toString() === c.customerNumber.toString());
    const hasMultipleLoans = allLoans.length > 1 || (c.loanNumber && c.loanNumber > 1);
    const loanBadgeHtml = hasMultipleLoans ? ` <span class="loan-badge">L${c.loanNumber || 1}</span>` : '';
    const totalCustGiven = allLoans.reduce((sum, x) => sum + (Number(x.givenAmount) || 0), 0);
    const totalCustPayable = allLoans.reduce((sum, x) => sum + (Number(x.totalPayable) || 0), 0);
    const totalCustBal = allLoans.reduce((sum, x) => sum + getCustomerStats(x).balance, 0);

    const rating = stats.creditRating || calculateCreditRating(c);
    const avatarHtml = c.photoUrl
      ? `<img src="${c.photoUrl}" alt="Photo" class="cust-avatar-img" style="width:34px; height:34px; border-radius:50%; object-fit:cover; border:1px solid #cbd5e1; flex-shrink:0; cursor:pointer;" onclick="openCustomerPhotoLightbox('${c.id}', event)" title="Click to view borrower photo & KYC details">`
      : `<div class="cust-avatar" style="width:34px; height:34px; border-radius:50%; background:#e2e8f0; color:#334155; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; flex-shrink:0; cursor:pointer;" onclick="openCustomerPhotoLightbox('${c.id}', event)" title="Click to view borrower profile & KYC details">${(c.fullName || 'C').charAt(0).toUpperCase()}</div>`;
    const creditBadgeHtml = `<span class="credit-badge ${rating.badgeClass}" title="Credit Health: ${rating.stars} (${rating.tier})">⭐ ${rating.score.toFixed(1)}</span>`;
    const kycBadgeHtml = c.kycVerified
      ? `<span class="kyc-badge" onclick="openKycViewerModal('${c.id}')" title="KYC Verified - Click to View">✓ KYC</span>`
      : (c.photoUrl || c.kycDocUrl ? `<span class="kyc-badge kyc-badge-unverified" onclick="openKycViewerModal('${c.id}')" title="KYC Submitted - Click to View">🪪 Docs</span>` : '');
    const settledBadgeHtml = c.isSettled
      ? `<span class="badge" style="background:#ecfdf5; color:#059669; border:1px solid #a7f3d0; font-size:10px; padding:1px 6px; font-weight:700; border-radius:4px; cursor:pointer;" onclick="openNOCModal('${c.id}')" title="Foreclosed & Settled. Click to view NOC">🤝 Settled</span>`
      : '';
    const guarantorHtml = c.guarantorName
      ? `<div style="font-size:10.5px; color:#64748b; margin-top:2px; display:flex; align-items:center; gap:4px;">
           <span>👥 Surety: <strong>${c.guarantorName}</strong></span>
           ${c.guarantorPhone ? `<a href="javascript:void(0)" onclick="contactGuarantor('${c.id}', 'wa')" title="WhatsApp Guarantor / Surety" style="color:#16a34a; text-decoration:none; font-weight:700;">📲 WA</a>` : ''}
         </div>`
      : '';

    return `
      <tr>
        <td>
          <strong style="color:#1e3a8a; font-size:14px;">#${c.customerNumber}</strong>${loanBadgeHtml}
          ${stats.isOverdue ? `<br><span class="badge-overdue" style="margin-top:2px;" title="Delayed Schedule: Borrower is ${stats.missedCount} instalments behind schedule (Overdue: ${formatMoney(stats.missedCount * (c.instalmentAmount || 0))})">⚠️ Due ${stats.missedCount}</span>` : ''}
        </td>
        <td>
          <div style="display:flex; align-items:center; gap:8px;">
            ${avatarHtml}
            <div>
              <div style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
                <span style="font-weight:600; color:#0f172a;">${c.fullName}</span>
                ${creditBadgeHtml}
                ${kycBadgeHtml}
                ${settledBadgeHtml}
              </div>
              <div style="font-size:12px; color:#64748b;">${c.address || 'No Address'}</div>
              ${guarantorHtml}
            </div>
          </div>
        </td>
        <td>${c.phone || '-'}</td>
        <td><span style="background:#e0f2fe; color:#0369a1; padding:2px 8px; border-radius:4px; font-size:11px;">${c.areaRoute || 'General'}</span></td>
        <td style="text-align: center;">
          <button type="button" class="loans-badge" onclick="toggleLoansTooltip(event, '${c.customerNumber}')" title="Click to view all loans for #${c.customerNumber}">
            <span>💳</span>
            <span>${allLoans.length} ${allLoans.length === 1 ? 'Loan' : 'Loans'}</span>
            <span style="font-size:10px;">▾</span>
          </button>
        </td>
        <td>
          <strong>${formatMoney(c.givenAmount)}</strong>
          ${hasMultipleLoans ? `<div class="cust-total-sub" title="Combined across ${allLoans.length} loans">Total: ${formatMoney(totalCustGiven)}</div>` : ''}
        </td>
        <td>
          <div style="font-weight:600;">${formatMoney(c.instalmentAmount)} ${c.frequency === 'Daily' || totalInst === 100 ? '/day' : '/wk'}</div>
          ${c.frequency === 'Daily' || totalInst === 100 
            ? '<span style="background:#fef3c7; color:#b45309; padding:1px 5px; border-radius:3px; font-size:10px; font-weight:700;">Daily</span>'
            : '<span style="background:#eff6ff; color:#1d4ed8; padding:1px 5px; border-radius:3px; font-size:10px; font-weight:700;">Weekly</span>'}
        </td>
        <td>
          <strong>${formatMoney(stats.totalPayable)}</strong>
          ${hasMultipleLoans ? `<div class="cust-total-sub" title="Combined payable across ${allLoans.length} loans">Total: ${formatMoney(totalCustPayable)}</div>` : ''}
        </td>
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
        <td>
          <strong style="color:#b45309;">${formatMoney(stats.balance)}</strong>
          ${hasMultipleLoans ? `<div class="cust-total-sub" title="Combined balance across ${allLoans.length} loans">Total Bal: ${formatMoney(totalCustBal)}</div>` : ''}
        </td>
        <td>
          <div class="cust-row-actions">
            <button type="button" class="btn-cust-action btn-cust-edit" onclick="openEditCustomerModal('${c.id}')" title="Edit Customer Profile">✏️ Edit</button>
            <button type="button" class="btn-cust-action btn-cust-passbook" onclick="openCustomerPassbook('${c.id}')" title="Passbook & Statement">🧾 Passbook</button>
            <button type="button" class="btn-cust-action btn-cust-delete" onclick="deleteCustomer('${c.id}')" title="Delete Customer & Loan">🗑️ Delete</button>
            <button type="button" class="btn-cust-action btn-cust-more" onclick="toggleCustomerActionsMenu(event, '${c.id}')" title="More Customer Actions (Thermal Slip, Additional Loan, WhatsApp, Settlement, KYC)">⋯ More</button>
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
      const allLoans = state.customers.filter(x => x.customerNumber.toString() === c.customerNumber.toString());
      const hasMultipleLoans = allLoans.length > 1 || (c.loanNumber && c.loanNumber > 1);
      const loanBadgeHtml = hasMultipleLoans ? `<span class="loan-badge">L${c.loanNumber || 1}</span>` : '';
      const totalCustGiven = allLoans.reduce((sum, x) => sum + (Number(x.givenAmount) || 0), 0);
      const totalCustPayable = allLoans.reduce((sum, x) => sum + (Number(x.totalPayable) || 0), 0);
      const totalCustBal = allLoans.reduce((sum, x) => sum + getCustomerStats(x).balance, 0);

      const rating = stats.creditRating || calculateCreditRating(c);
      const avatarHtml = c.photoUrl
        ? `<img src="${c.photoUrl}" alt="Photo" class="cust-avatar-img" style="width:36px; height:36px; border-radius:50%; object-fit:cover; border:1px solid #cbd5e1; flex-shrink:0; cursor:pointer;" onclick="openCustomerPhotoLightbox('${c.id}', event)" title="Click to view borrower photo & KYC details">`
        : `<div class="cust-avatar" style="width:36px; height:36px; border-radius:50%; background:#e2e8f0; color:#334155; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; flex-shrink:0; cursor:pointer;" onclick="openCustomerPhotoLightbox('${c.id}', event)" title="Click to view borrower profile & KYC details">${(c.fullName || 'C').charAt(0).toUpperCase()}</div>`;
      const creditBadgeHtml = `<span class="credit-badge ${rating.badgeClass}" title="Credit Health: ${rating.stars} (${rating.tier})">⭐ ${rating.score.toFixed(1)}</span>`;
      const kycBadgeHtml = c.kycVerified
        ? `<span class="kyc-badge" onclick="openKycViewerModal('${c.id}')" title="KYC Verified - Click to View">✓ KYC</span>`
        : (c.photoUrl || c.kycDocUrl ? `<span class="kyc-badge kyc-badge-unverified" onclick="openKycViewerModal('${c.id}')" title="KYC Submitted - Click to View">🪪 Docs</span>` : '');
      const settledBadgeHtml = c.isSettled
        ? `<span class="badge" style="background:#ecfdf5; color:#059669; border:1px solid #a7f3d0; font-size:10px; padding:1px 6px; font-weight:700; border-radius:4px; cursor:pointer;" onclick="openNOCModal('${c.id}')" title="Foreclosed & Settled. Click to view NOC">🤝 Settled</span>`
        : '';
      const guarantorHtml = c.guarantorName
        ? `<div style="font-size:10.5px; color:#64748b; margin-top:2px; display:flex; align-items:center; gap:4px;">
             <span>👥 Surety: <strong>${c.guarantorName}</strong></span>
             ${c.guarantorPhone ? `<a href="javascript:void(0)" onclick="contactGuarantor('${c.id}', 'wa')" title="WhatsApp Guarantor / Surety" style="color:#16a34a; text-decoration:none; font-weight:700;">📲 WA</a>` : ''}
           </div>`
        : '';

      return `
        <div class="customer-card">
          <div class="customer-card-header">
            <div class="customer-card-title">
              <span class="customer-card-num">#${c.customerNumber}</span>
              ${loanBadgeHtml}
              ${avatarHtml}
              <div>
                <div class="customer-card-name" style="display:flex; align-items:center; gap:5px; flex-wrap:wrap;">
                  <span>${c.fullName}</span>
                  ${creditBadgeHtml}
                  ${kycBadgeHtml}
                  ${settledBadgeHtml}
                </div>
                <div class="customer-card-meta">${c.phone || 'No Phone'} • <span style="background:#e0f2fe; color:#0369a1; padding:1px 6px; border-radius:4px; font-size:11px;">${c.areaRoute || 'General'}</span></div>
                ${guarantorHtml}
              </div>
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0;">
              <button type="button" class="loans-badge" onclick="toggleLoansTooltip(event, '${c.customerNumber}')" title="Click to view all loans for #${c.customerNumber}">
                <span>💳</span>
                <span>${allLoans.length} ${allLoans.length === 1 ? 'Loan' : 'Loans'}</span>
                <span style="font-size:10px;">▾</span>
              </button>
              <span class="badge-status ${stats.isCompleted ? 'badge-status-completed' : 'badge-status-active'}">${stats.isCompleted ? '✓ Completed' : '● Active'}</span>
              ${stats.isOverdue ? `<span class="badge-status badge-status-overdue" title="Delayed Schedule: Borrower is ${stats.missedCount} instalments behind schedule (Overdue: ${formatMoney(stats.missedCount * (c.instalmentAmount || 0))})">⚠️ Due ${stats.missedCount}</span>` : ''}
            </div>
          </div>

          <div class="customer-card-grid">
            <div>
              <div class="card-stat-label">Given Amount</div>
              <div class="card-stat-val" style="color:#1e3a8a;">
                ${formatMoney(c.givenAmount)}
                ${hasMultipleLoans ? `<div class="cust-total-sub">Total: ${formatMoney(totalCustGiven)}</div>` : ''}
              </div>
            </div>
            <div>
              <div class="card-stat-label">Total Repayable</div>
              <div class="card-stat-val">
                ${formatMoney(stats.totalPayable)}
                ${hasMultipleLoans ? `<div class="cust-total-sub">Total: ${formatMoney(totalCustPayable)}</div>` : ''}
              </div>
            </div>
            <div>
              <div class="card-stat-label">Collected (${stats.paidCount}/${totalInst})</div>
              <div class="card-stat-val" style="color:#16a34a;">${formatMoney(stats.totalPaid)}</div>
            </div>
            <div>
              <div class="card-stat-label">Remaining Balance</div>
              <div class="card-stat-val" style="color:#b45309;">
                ${formatMoney(stats.balance)}
                ${hasMultipleLoans ? `<div class="cust-total-sub">Total Bal: ${formatMoney(totalCustBal)}</div>` : ''}
              </div>
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
            <button type="button" class="btn-cust-action btn-cust-edit" onclick="openEditCustomerModal('${c.id}')">✏️ Edit</button>
            <button type="button" class="btn-cust-action btn-cust-passbook" onclick="openCustomerPassbook('${c.id}')">🧾 Passbook</button>
            <button type="button" class="btn-cust-action btn-cust-delete" onclick="deleteCustomer('${c.id}')">🗑️ Delete</button>
            <button type="button" class="btn-cust-action btn-cust-more" onclick="toggleCustomerActionsMenu(event, '${c.id}')">⋯ More</button>
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
  const marginPct = Number(document.getElementById('cust-form-margin')?.value) || 4.0;
  const instalments = Number(document.getElementById('cust-form-instalments')?.value) || 52;
  if (given > 0 && instalments > 0) {
    const repayable = Math.round(given * (1 + marginPct / 100));
    const instAmount = Math.ceil(repayable / instalments);
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
  const freqInput = document.getElementById('cust-form-frequency');
  const amountLabel = document.getElementById('cust-form-amount-label');
  const freqHelp = document.getElementById('cust-form-freq-help');
  const amountInput = document.getElementById('cust-form-amount');

  if (instInput) instInput.value = count;

  const isDaily = count === 100;
  if (freqInput) freqInput.value = isDaily ? 'Daily' : 'Weekly';
  if (amountLabel) amountLabel.textContent = isDaily ? 'Instalment Amount (₹ / day):' : 'Instalment Amount (₹ / week):';
  if (freqHelp) freqHelp.textContent = isDaily ? 'Daily collection schedule (100 Days)' : `Weekly collection schedule (${count} Weeks)`;

  const curAmt = Number(amountInput?.value) || 0;
  if (curAmt > 0) {
    calculateFromAmount();
  } else {
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
    const nextNum = findNextAvailableCustomerNumber(state.settings.nextCustNumber || 1);
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

  // PRO FEATURE 6: Display Credit Health Rating & Recommended Next Limit
  const rating = calculateCreditRating(base);
  const recWrap = document.getElementById('cust-form-credit-rec-wrap');
  if (recWrap) {
    recWrap.style.display = 'block';
    const starsEl = document.getElementById('cust-form-rec-stars');
    if (starsEl) starsEl.textContent = `⭐ ${rating.stars} ${rating.tier}`;
    const sumEl = document.getElementById('cust-form-rec-loans-summary');
    if (sumEl) sumEl.textContent = `(${rating.missedCount} missed • ${rating.completedCount} completed)`;
    const limEl = document.getElementById('cust-form-rec-limit');
    if (limEl) limEl.textContent = formatMoney(rating.recommendedLimit);
  }

  // Pre-fill Photo, KYC, and Guarantor from base loan
  if (base.photoUrl) {
    document.getElementById('cust-form-photo-data').value = base.photoUrl;
    const previewBox = document.getElementById('cust-form-photo-preview-box');
    if (previewBox) previewBox.innerHTML = `<img src="${base.photoUrl}" alt="Borrower" class="cust-avatar-img">`;
    const clearBtn = document.getElementById('cust-form-photo-clear-btn');
    if (clearBtn) clearBtn.style.display = 'inline-block';
  } else {
    clearCustomerPhoto();
  }

  const kycChk = document.getElementById('cust-form-kyc-verified');
  if (kycChk) kycChk.checked = Boolean(base.kycVerified);

  if (base.kycDocUrl) {
    document.getElementById('cust-form-kyc-doc-data').value = base.kycDocUrl;
    document.getElementById('cust-form-kyc-doc-name').value = base.kycDocName || '';
    const label = document.getElementById('cust-form-kyc-doc-label');
    if (label) label.textContent = base.kycDocName || 'KYC Document attached';
    const clearDocBtn = document.getElementById('cust-form-kyc-doc-clear-btn');
    if (clearDocBtn) clearDocBtn.style.display = 'inline-block';
  } else {
    clearKycDoc();
  }

  const guar = base.guarantor || {};
  const guarName = document.getElementById('cust-form-guar-name');
  if (guarName) guarName.value = guar.name || '';
  const guarPhone = document.getElementById('cust-form-guar-phone');
  if (guarPhone) guarPhone.value = guar.phone || '';
  const guarRel = document.getElementById('cust-form-guar-rel');
  if (guarRel) guarRel.value = guar.rel || '';
  const guarAddr = document.getElementById('cust-form-guar-address');
  if (guarAddr) guarAddr.value = guar.address || '';

  const titleEl = document.getElementById('modal-customer-title');
  if (titleEl) titleEl.textContent = `Issue Loan #${nextLoan} to #${base.customerNumber} (${base.fullName})`;

  const helpEl = document.getElementById('existing-cust-loan-count-help');
  if (helpEl) {
    helpEl.textContent = `Customer already has ${matching.length} loan(s). This creates separate ledger Loan #${nextLoan}.`;
  }
}

function applyRecommendedCreditLimit() {
  const custNum = document.getElementById('cust-form-number')?.value;
  if (!custNum) return;
  const base = state.customers.find(c => c.customerNumber.toString() === custNum.toString());
  if (!base) return;
  const rating = calculateCreditRating(base);
  const givenInput = document.getElementById('cust-form-given');
  if (givenInput) {
    givenInput.value = rating.recommendedLimit;
    calculateFromMargin();
    showToast(`✓ Applied recommended limit: ${formatMoney(rating.recommendedLimit)}`);
  }
}

// PRO FEATURE 1: Borrower Camera Photo Capture & Compressed Upload
function handleCustomerPhotoUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = function(e) {
    const img = new Image();
    img.onload = function() {
      const canvas = document.createElement('canvas');
      const maxDim = 240;
      let width = img.width;
      let height = img.height;
      if (width > height) {
        if (width > maxDim) {
          height = Math.round((height * maxDim) / width);
          width = maxDim;
        }
      } else {
        if (height > maxDim) {
          width = Math.round((width * maxDim) / height);
          height = maxDim;
        }
      }
      canvas.width = width;
      canvas.height = height;
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, width, height);
      const compressedDataUrl = canvas.toDataURL('image/jpeg', 0.8);

      document.getElementById('cust-form-photo-data').value = compressedDataUrl;
      const previewBox = document.getElementById('cust-form-photo-preview-box');
      if (previewBox) {
        previewBox.innerHTML = `<img src="${compressedDataUrl}" alt="Borrower" class="cust-avatar-img">`;
      }
      const clearBtn = document.getElementById('cust-form-photo-clear-btn');
      if (clearBtn) clearBtn.style.display = 'inline-block';
    };
    img.src = e.target.result;
  };
  reader.readAsDataURL(file);
}

function clearCustomerPhoto() {
  const input = document.getElementById('cust-form-photo-input');
  if (input) input.value = '';
  const dataInput = document.getElementById('cust-form-photo-data');
  if (dataInput) dataInput.value = '';
  const previewBox = document.getElementById('cust-form-photo-preview-box');
  if (previewBox) previewBox.innerHTML = '👤';
  const clearBtn = document.getElementById('cust-form-photo-clear-btn');
  if (clearBtn) clearBtn.style.display = 'none';
}

function handleKycDocUpload(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const filename = file.name || 'KYC_Document.pdf';
  document.getElementById('cust-form-kyc-doc-name').value = filename;
  const label = document.getElementById('cust-form-kyc-doc-label');
  if (label) label.textContent = filename;

  const reader = new FileReader();
  reader.onload = function(e) {
    document.getElementById('cust-form-kyc-doc-data').value = e.target.result;
    const clearBtn = document.getElementById('cust-form-kyc-doc-clear-btn');
    if (clearBtn) clearBtn.style.display = 'inline-block';
  };
  reader.readAsDataURL(file);
}

function clearKycDoc() {
  const input = document.getElementById('cust-form-kyc-doc-input');
  if (input) input.value = '';
  document.getElementById('cust-form-kyc-doc-name').value = '';
  document.getElementById('cust-form-kyc-doc-data').value = '';
  const label = document.getElementById('cust-form-kyc-doc-label');
  if (label) label.textContent = 'No document attached';
  const clearBtn = document.getElementById('cust-form-kyc-doc-clear-btn');
  if (clearBtn) clearBtn.style.display = 'none';
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

  const minPrincipal = (state.settings && !isNaN(state.settings.minGivenAmount) && Number(state.settings.minGivenAmount) > 0)
    ? Number(state.settings.minGivenAmount)
    : 1000;

  const givenInput = document.getElementById('cust-form-given');
  const instInput = document.getElementById('cust-form-instalments');
  const amtInput = document.getElementById('cust-form-amount');
  const dateInput = document.getElementById('cust-form-date');
  const lockNotice = document.getElementById('cust-form-lock-notice');
  const presetsWrap = document.getElementById('cust-form-presets-wrap');

  if (givenInput) {
    givenInput.readOnly = false;
    givenInput.classList.remove('locked-field');
    givenInput.min = minPrincipal;
    givenInput.title = '';
  }
  if (instInput) {
    instInput.readOnly = false;
    instInput.classList.remove('locked-field');
    instInput.title = '';
  }
  if (amtInput) {
    amtInput.readOnly = false;
    amtInput.classList.remove('locked-field');
    amtInput.title = '';
  }
  if (dateInput) {
    dateInput.readOnly = false;
    dateInput.disabled = false;
    dateInput.classList.remove('locked-field');
    dateInput.title = '';
  }
  if (lockNotice) lockNotice.style.display = 'none';
  if (presetsWrap) presetsWrap.style.display = 'flex';

  document.getElementById('cust-form-name').value = '';
  document.getElementById('cust-form-phone').value = '';
  document.getElementById('cust-form-address').value = '';
  document.getElementById('cust-form-area').value = 'Main Area';
  document.getElementById('cust-form-given').value = Math.max(minPrincipal, state.settings.defaultGivenAmount || 10000);
  document.getElementById('cust-form-margin').value = '4.0';
  document.getElementById('cust-form-instalments').value = state.settings.defaultInstalments || 52;
  document.getElementById('cust-form-amount').value = state.settings.defaultInstalmentAmount || 200;
  document.getElementById('cust-form-date').value = getISTDateString();

  // Reset Photo, KYC, and Guarantor
  clearCustomerPhoto();
  clearKycDoc();
  const kycChk = document.getElementById('cust-form-kyc-verified');
  if (kycChk) kycChk.checked = false;
  const guarName = document.getElementById('cust-form-guar-name');
  if (guarName) guarName.value = '';
  const guarPhone = document.getElementById('cust-form-guar-phone');
  if (guarPhone) guarPhone.value = '';
  const guarRel = document.getElementById('cust-form-guar-rel');
  if (guarRel) guarRel.value = '';
  const guarAddr = document.getElementById('cust-form-guar-address');
  if (guarAddr) guarAddr.value = '';
  const recWrap = document.getElementById('cust-form-credit-rec-wrap');
  if (recWrap) recWrap.style.display = 'none';

  const freqInput = document.getElementById('cust-form-frequency');
  const amountLabel = document.getElementById('cust-form-amount-label');
  const freqHelp = document.getElementById('cust-form-freq-help');
  if (freqInput) freqInput.value = 'Weekly';
  if (amountLabel) amountLabel.textContent = 'Instalment Amount (₹ / week):';
  if (freqHelp) freqHelp.textContent = 'Weekly collection schedule';

  calculateFromMargin();
  openModal('modal-customer');
}

// Open Edit Customer Modal
function openEditCustomerModal(customerId) {
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  const loanNum = c.loanNumber || 1;
  const isDaily = c.frequency === 'Daily' || (c.totalInstalments === 100);

  const minPrincipal = (state.settings && !isNaN(state.settings.minGivenAmount) && Number(state.settings.minGivenAmount) > 0)
    ? Number(state.settings.minGivenAmount)
    : 1000;

  const hasAnyPayment = (c.instalments || []).some(
    i => i && (i.status === 'Received' || i.status === 'Partial' || (Number(i.paidAmount) || 0) > 0)
  );

  const givenInput = document.getElementById('cust-form-given');
  const instInput = document.getElementById('cust-form-instalments');
  const amtInput = document.getElementById('cust-form-amount');
  const dateInput = document.getElementById('cust-form-date');
  const lockNotice = document.getElementById('cust-form-lock-notice');
  const presetsWrap = document.getElementById('cust-form-presets-wrap');

  if (hasAnyPayment) {
    if (givenInput) {
      givenInput.readOnly = true;
      givenInput.classList.add('locked-field');
      givenInput.title = 'Principal amount is locked because payments have been recorded.';
    }
    if (instInput) {
      instInput.readOnly = true;
      instInput.classList.add('locked-field');
      instInput.title = 'Total instalments is locked because payments have been recorded.';
    }
    if (amtInput) {
      amtInput.readOnly = true;
      amtInput.classList.add('locked-field');
      amtInput.title = 'Instalment amount is locked because payments have been recorded.';
    }
    if (dateInput) {
      dateInput.readOnly = true;
      dateInput.disabled = true;
      dateInput.classList.add('locked-field');
      dateInput.title = 'Loan start date is locked because payments have been recorded.';
    }
    if (lockNotice) lockNotice.style.display = 'block';
    if (presetsWrap) presetsWrap.style.display = 'none';
  } else {
    // 0 payments or all payments undone -> allow full edit
    if (givenInput) {
      givenInput.readOnly = false;
      givenInput.classList.remove('locked-field');
      givenInput.min = minPrincipal;
      givenInput.title = '';
    }
    if (instInput) {
      instInput.readOnly = false;
      instInput.classList.remove('locked-field');
      instInput.title = '';
    }
    if (amtInput) {
      amtInput.readOnly = false;
      amtInput.classList.remove('locked-field');
      amtInput.title = '';
    }
    if (dateInput) {
      dateInput.readOnly = false;
      dateInput.disabled = false;
      dateInput.classList.remove('locked-field');
      dateInput.title = '';
    }
    if (lockNotice) lockNotice.style.display = 'none';
    if (presetsWrap) presetsWrap.style.display = 'flex';
  }

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
  document.getElementById('cust-form-date').value = c.startDate || getISTDateString();

  const freqInput = document.getElementById('cust-form-frequency');
  const amountLabel = document.getElementById('cust-form-amount-label');
  const freqHelp = document.getElementById('cust-form-freq-help');
  if (freqInput) freqInput.value = isDaily ? 'Daily' : 'Weekly';
  if (amountLabel) amountLabel.textContent = isDaily ? 'Instalment Amount (₹ / day):' : 'Instalment Amount (₹ / week):';
  if (freqHelp) freqHelp.textContent = isDaily ? 'Daily collection schedule (100 Days)' : `Weekly collection schedule (${c.totalInstalments || 52} Weeks)`;

  // Load Borrower Photo
  if (c.photoUrl) {
    document.getElementById('cust-form-photo-data').value = c.photoUrl;
    const previewBox = document.getElementById('cust-form-photo-preview-box');
    if (previewBox) previewBox.innerHTML = `<img src="${c.photoUrl}" alt="Borrower" class="cust-avatar-img">`;
    const clearBtn = document.getElementById('cust-form-photo-clear-btn');
    if (clearBtn) clearBtn.style.display = 'inline-block';
  } else {
    clearCustomerPhoto();
  }

  // Load KYC Document Proof
  if (c.kycDocUrl) {
    document.getElementById('cust-form-kyc-doc-data').value = c.kycDocUrl;
    document.getElementById('cust-form-kyc-doc-name').value = c.kycDocName || '';
    const label = document.getElementById('cust-form-kyc-doc-label');
    if (label) label.textContent = c.kycDocName || 'KYC Document attached';
    const clearDocBtn = document.getElementById('cust-form-kyc-doc-clear-btn');
    if (clearDocBtn) clearDocBtn.style.display = 'inline-block';
  } else {
    clearKycDoc();
  }

  // Load KYC Verified Status
  const kycChk = document.getElementById('cust-form-kyc-verified');
  if (kycChk) kycChk.checked = Boolean(c.kycVerified);

  // Load Guarantor / Surety Details
  const guar = c.guarantor || {};
  const guarName = document.getElementById('cust-form-guar-name');
  if (guarName) guarName.value = guar.name || '';
  const guarPhone = document.getElementById('cust-form-guar-phone');
  if (guarPhone) guarPhone.value = guar.phone || '';
  const guarRel = document.getElementById('cust-form-guar-rel');
  if (guarRel) guarRel.value = guar.rel || '';
  const guarAddr = document.getElementById('cust-form-guar-address');
  if (guarAddr) guarAddr.value = guar.address || '';

  const wrap = document.getElementById('existing-customer-selector-wrap');
  if (wrap) wrap.style.display = 'none';
  const recWrap = document.getElementById('cust-form-credit-rec-wrap');
  if (recWrap) recWrap.style.display = 'none';

  calculateFromAmount();
  openModal('modal-customer');
}

// Save Customer (Create or Update with Multi-Loan & Frequency support)
async function handleSaveCustomer(event) {
  event.preventDefault();

  const id = document.getElementById('form-customer-id').value;
  const rawCustNum = document.getElementById('cust-form-number')?.value.trim();
  const rawFullName = document.getElementById('cust-form-name')?.value.trim();
  const rawGiven = document.getElementById('cust-form-given')?.value.trim();
  const rawInstCount = document.getElementById('cust-form-instalments')?.value.trim();
  const rawInstAmt = document.getElementById('cust-form-amount')?.value.trim();
  const loanNumber = Number(document.getElementById('cust-form-loan-number')?.value) || 1;
  const phone = document.getElementById('cust-form-phone')?.value.trim() || '';
  const address = document.getElementById('cust-form-address')?.value.trim() || '';
  const areaRoute = document.getElementById('cust-form-area')?.value.trim() || 'Main Area';
  const startDate = document.getElementById('cust-form-date')?.value || getISTDateString();

  // PRO FEATURES 1 & 2: Borrower Photo, KYC Vault & Guarantor
  const photoUrl = document.getElementById('cust-form-photo-data')?.value || '';
  const kycVerified = Boolean(document.getElementById('cust-form-kyc-verified')?.checked);
  const kycDocUrl = document.getElementById('cust-form-kyc-doc-data')?.value || '';
  const kycDocName = document.getElementById('cust-form-kyc-doc-name')?.value || '';
  const guarantorName = document.getElementById('cust-form-guar-name')?.value.trim() || '';
  const guarantorPhone = document.getElementById('cust-form-guar-phone')?.value.trim() || '';
  const guarantorRel = document.getElementById('cust-form-guar-rel')?.value.trim() || '';
  const guarantorAddress = document.getElementById('cust-form-guar-address')?.value.trim() || '';

  const guarantor = {
    name: guarantorName,
    phone: guarantorPhone,
    rel: guarantorRel,
    address: guarantorAddress,
  };

  // Strict Form Validation (Zero Silent Defaults)
  if (!rawCustNum || isNaN(rawCustNum) || Number(rawCustNum) <= 0) {
    alert('Please enter a valid Customer Number (e.g. 1, 2, 3...)');
    return;
  }
  if (!rawFullName) {
    alert('Please enter Customer Full Name');
    return;
  }
  const minPrincipal = (state.settings && !isNaN(state.settings.minGivenAmount) && Number(state.settings.minGivenAmount) > 0)
    ? Number(state.settings.minGivenAmount)
    : 1000;
  if (!rawGiven || isNaN(rawGiven) || Number(rawGiven) < minPrincipal) {
    alert(`Given Principal Amount (₹) must be at least ₹${minPrincipal.toLocaleString('en-IN')}. (Configurable in Settings)`);
    return;
  }
  if (!rawInstCount || isNaN(rawInstCount) || Number(rawInstCount) <= 0) {
    alert('Please enter valid Total Instalments (e.g. 52 or 20)');
    return;
  }
  if (!rawInstAmt || isNaN(rawInstAmt) || Number(rawInstAmt) <= 0) {
    alert('Please enter a valid Instalment Amount greater than 0');
    return;
  }

  let customerNumber = rawCustNum;
  const fullName = rawFullName;
  const givenAmount = Number(rawGiven);
  const totalInstalments = Number(rawInstCount);
  const instalmentAmount = Number(rawInstAmt);
  const frequency = document.getElementById('cust-form-frequency')?.value || (totalInstalments === 100 ? 'Daily' : 'Weekly');

  // Verify and auto-resolve customer ID collision for new customers in multi-user environments
  if (!id && loanNumber === 1) {
    if (typeof getNextAtomicCustomerNumber === 'function' && isCloudSyncActive) {
      try {
        const verified = await getNextAtomicCustomerNumber(customerNumber, fullName);
        if (verified && String(verified) !== String(customerNumber)) {
          showToast(`ℹ️ Customer #${customerNumber} was already taken. Auto-assigned Customer #${verified}.`, 4000);
          customerNumber = String(verified);
        }
      } catch (e) {
        console.warn('Atomic customer number check failed, falling back to local pool', e);
      }
    } else {
      const existOther = state.customers.find(c => c.customerNumber.toString() === customerNumber.toString() && (c.fullName || '').trim().toLowerCase() !== fullName.toLowerCase());
      if (existOther) {
        const nextFree = findNextAvailableCustomerNumber(Number(customerNumber));
        showToast(`ℹ️ Customer #${customerNumber} already exists. Auto-assigned Customer #${nextFree}.`, 4000);
        customerNumber = String(nextFree);
      }
    }
  }

  // Check duplicate customer number AND loan number combination
  const duplicate = state.customers.find((c) =>
    c.customerNumber.toString() === customerNumber &&
    (Number(c.loanNumber) || 1) === loanNumber &&
    c.id !== id
  );

  if (duplicate) {
    if (id) {
      alert(`Customer #${customerNumber} Loan #${loanNumber} already exists. Please choose a different loan number.`);
      return;
    } else {
      const nextFree = findNextAvailableCustomerNumber(Number(customerNumber));
      customerNumber = String(nextFree);
    }
  }

  if (id) {
    // Edit existing loan
    const existing = state.customers.find((c) => c.id === id);
    if (existing) {
      const existingInsts = existing.instalments || [];
      const hasAnyPayment = existingInsts.some(i => i && (i.status === 'Received' || i.status === 'Partial' || (Number(i.paidAmount) || 0) > 0));

      if (hasAnyPayment) {
        if (
          givenAmount !== Number(existing.givenAmount) ||
          totalInstalments !== Number(existing.totalInstalments) ||
          instalmentAmount !== Number(existing.instalmentAmount)
        ) {
          alert('Cannot modify Principal Amount, Number of Instalments, or Instalment Amount while payments exist. To edit these terms, undo all received instalments first in the collection sheet.');
          return;
        }
      }

      let highestPaidNumber = 0;
      existingInsts.forEach(i => {
        if (i && (i.status === 'Received' || i.status === 'Partial')) {
          highestPaidNumber = Math.max(highestPaidNumber, i.number);
        }
      });

      // Invariant: Historical Record Revision Floor (Pitfall #10)
      if (totalInstalments < highestPaidNumber) {
        alert(`Cannot reduce term to ${totalInstalments} instalments. Customer has already paid up to instalment #${highestPaidNumber}!`);
        return;
      }

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
      existing.startDate = hasAnyPayment ? (existing.startDate || startDate) : startDate;
      existing.frequency = frequency;
      existing.photoUrl = photoUrl;
      existing.kycVerified = kycVerified;
      existing.kycDocUrl = kycDocUrl;
      existing.kycDocName = kycDocName;
      existing.guarantor = guarantor;

      // Reschedule instalments: adjust count while preserving all paid history
      if (totalInstalments < existingInsts.length) {
        existing.instalments = existingInsts.slice(0, totalInstalments);
      } else if (totalInstalments > existingInsts.length) {
        for (let i = existingInsts.length + 1; i <= totalInstalments; i++) {
          existing.instalments.push({
            number: i,
            dueAmount: instalmentAmount,
            paidAmount: 0,
            status: 'Pending',
          });
        }
      }
      // Update dueAmount and paid amounts to match the revised instalmentAmount
      existing.instalments.forEach(i => {
        if (i.status === 'Pending') {
          i.dueAmount = instalmentAmount;
          i.paidAmount = 0;
        } else if (i.status === 'Received') {
          i.dueAmount = instalmentAmount;
          i.paidAmount = instalmentAmount;
        } else if (i.status === 'Partial') {
          i.dueAmount = instalmentAmount;
        }
      });

      // Synchronize shared contact, photo, KYC, and guarantor details across all loans of this customer
      state.customers.forEach(other => {
        if (other.customerNumber.toString() === customerNumber.toString() && other.id !== existing.id) {
          other.fullName = fullName;
          other.phone = phone;
          other.address = address;
          other.areaRoute = areaRoute;
          other.photoUrl = photoUrl;
          other.kycVerified = kycVerified;
          other.kycDocUrl = kycDocUrl;
          other.kycDocName = kycDocName;
          other.guarantor = guarantor;
          if (typeof syncCustomerToFirestore === 'function') {
            syncCustomerToFirestore(other);
          }
        }
      });
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
      frequency,
      photoUrl,
      kycVerified,
      kycDocUrl,
      kycDocName,
      guarantor,
      instalments,
      createdAt: new Date().toISOString(),
    });

    if (loanNumber === 1) {
      state.settings.nextCustNumber = findNextAvailableCustomerNumber(1);
    }

    // Sync contact info to existing loans of this customer if creating L2/L3
    state.customers.forEach(other => {
      if (other.customerNumber.toString() === customerNumber.toString() && other.id !== newId) {
        other.fullName = fullName;
        other.phone = phone;
        other.address = address;
        other.areaRoute = areaRoute;
        other.photoUrl = photoUrl;
        other.kycVerified = kycVerified;
        other.kycDocUrl = kycDocUrl;
        other.kycDocName = kycDocName;
        other.guarantor = guarantor;
        if (typeof syncCustomerToFirestore === 'function') {
          syncCustomerToFirestore(other);
        }
      }
    });
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

// Delete Customer / Loan (Restricted to Owner/Admin)
function deleteCustomer(customerId) {
  const currentUser = getCurrentUser();
  if (currentUser.role === 'Collector') {
    alert('Access Denied: Only Owner / Admin can delete loans.');
    return;
  }

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

// ========================================================
// PRO FEATURE 1: BORROWER KYC DOCUMENT VAULT VIEWER
// ========================================================
function openKycViewerModal(customerId) {
  const c = state.customers.find(x => x.id === customerId);
  if (!c) return;

  const titleEl = document.getElementById('kyc-viewer-title');
  if (titleEl) {
    titleEl.innerHTML = `<span>🪪</span> Borrower KYC Vault: #${c.customerNumber} ${c.fullName}`;
  }

  const rating = calculateCreditRating(c);
  const avatarHtml = c.photoUrl
    ? `<img src="${c.photoUrl}" style="width: 80px; height: 80px; border-radius: 50%; object-fit: cover; border: 3px solid #2563eb;">`
    : `<div style="width: 80px; height: 80px; border-radius: 50%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; font-size: 32px;">👤</div>`;

  const kycStatusHtml = c.kycVerified
    ? `<span style="background: #ecfdf5; color: #047857; font-weight: 700; border: 1px solid #86efac; padding: 3px 10px; border-radius: 6px; font-size: 12px;">✓ Verified Customer</span>`
    : `<span style="background: #f8fafc; color: #64748b; font-weight: 700; border: 1px solid #cbd5e1; padding: 3px 10px; border-radius: 6px; font-size: 12px;">Pending Document Verification</span>`;

  let docProofHtml = '<div style="color: #64748b; font-size: 13px; font-style: italic;">No KYC ID proof document uploaded yet.</div>';
  if (c.kycDocUrl) {
    if (c.kycDocUrl.startsWith('data:image/')) {
      docProofHtml = `
        <div style="margin-top: 10px; border: 1px solid #cbd5e1; border-radius: 8px; overflow: hidden; max-height: 320px; text-align: center; background: #000;">
          <img src="${c.kycDocUrl}" alt="ID Document Proof" style="max-width: 100%; max-height: 320px; object-fit: contain;">
        </div>
      `;
    } else {
      docProofHtml = `
        <div style="margin-top: 10px; background: #eff6ff; border: 1px solid #bfdbfe; border-radius: 8px; padding: 12px; display: flex; align-items: center; justify-content: space-between;">
          <span style="font-weight: 600; color: #1e40af; font-size: 13px;">📎 ${c.kycDocName || 'KYC Document'}</span>
          <a href="${c.kycDocUrl}" download="${c.kycDocName || 'kyc-doc.pdf'}" class="btn btn-sm btn-primary">Download File</a>
        </div>
      `;
    }
  }

  const guar = c.guarantor || {};
  const guarantorHtml = guar.name ? `
    <div style="background: #f0fdf4; border: 1px solid #bbf7d0; border-radius: 8px; padding: 12px 16px; margin-top: 14px;">
      <div style="font-weight: 700; font-size: 12px; text-transform: uppercase; color: #166534; margin-bottom: 4px;">Registered Guarantor / Surety:</div>
      <div style="font-size: 14px; font-weight: 700; color: #1e293b;">${guar.name} (${guar.rel || 'Guarantor'})</div>
      <div style="font-size: 12.5px; color: #475569; margin-top: 2px;">Phone: ${guar.phone || 'N/A'} • Address: ${guar.address || 'N/A'}</div>
      ${guar.phone ? `
        <div style="margin-top: 8px; display: flex; gap: 8px;">
          <button type="button" class="btn btn-sm btn-success" onclick="contactGuarantor('${c.id}', 'whatsapp')">💬 WhatsApp Guarantor</button>
          <a href="tel:${guar.phone}" class="btn btn-sm btn-outline">📞 Call Guarantor</a>
        </div>
      ` : ''}
    </div>
  ` : '<div style="font-size: 12.5px; color: #64748b; margin-top: 10px; font-style: italic;">No guarantor recorded for this customer.</div>';

  const container = document.getElementById('kyc-viewer-content');
  if (container) {
    container.innerHTML = `
      <div style="display: flex; gap: 16px; align-items: center; border-bottom: 1px solid #e2e8f0; padding-bottom: 16px; margin-bottom: 16px;">
        ${avatarHtml}
        <div>
          <div style="font-size: 18px; font-weight: 800; color: #0f172a;">${c.fullName}</div>
          <div style="font-size: 12.5px; color: #64748b; margin: 2px 0 6px 0;">Customer #${c.customerNumber} • Phone: ${c.phone || 'N/A'} • Route: ${c.areaRoute || 'General'}</div>
          <div style="display: flex; align-items: center; gap: 8px; flex-wrap: wrap;">
            ${kycStatusHtml}
            <span class="credit-badge ${rating.badgeClass}">⭐ ${rating.stars} ${rating.tier}</span>
          </div>
        </div>
      </div>

      <div style="margin-bottom: 14px;">
        <div style="font-weight: 700; font-size: 13px; color: #1e293b; margin-bottom: 6px;">KYC Identity Proof Document:</div>
        ${docProofHtml}
      </div>

      <div>
        ${guarantorHtml}
      </div>
    `;
  }

  openModal('modal-kyc-viewer');
}

// ========================================================
// PRO FEATURE 2: GUARANTOR 1-TAP WHATSAPP & CALL RECOVERY
// ========================================================
function contactGuarantor(customerId, mode = 'whatsapp') {
  const c = state.customers.find(x => x.id === customerId);
  if (!c || !c.guarantor || !c.guarantor.phone) {
    showToast('No guarantor phone registered for this customer.');
    return;
  }

  const guar = c.guarantor;
  const stats = getCustomerStats(c);
  const bizName = (state.settings && state.settings.businessName) || 'JSR Finance';
  const cleanPhone = formatWhatsAppPhone(guar.phone);

  if (mode === 'call') {
    window.location.href = `tel:${cleanPhone}`;
    return;
  }

  const message = encodeURIComponent(
    `*${bizName} - Important Guarantor Notification*\n\n` +
    `Namaste ${guar.name} ji,\n` +
    `You are registered as the Guarantor / Surety for:\n` +
    `Borrower: *${c.fullName}* (Customer #${c.customerNumber}, Loan #${c.loanNumber || 1})\n\n` +
    `*Account Status:* ${stats.missedCount > 0 ? stats.missedCount + ' instalments overdue' : 'Active loan'}\n` +
    `*Outstanding Balance Due:* ${formatMoney(stats.balance)}\n\n` +
    `As the registered surety, please assist in ensuring immediate clearance of the account to maintain clean credit standing.\n\n` +
    `Thank you,\n${bizName}`
  );

  window.open(`https://wa.me/${cleanPhone}?text=${message}`, '_blank');
}

// ========================================================
// PRO FEATURE 4: BLUETOOTH THERMAL PRINTER (ESC/POS)
// ========================================================
let bluetoothPrinterDevice = null;
let bluetoothPrinterCharacteristic = null;

async function connectBluetoothPrinter() {
  if (!navigator.bluetooth) {
    alert('Web Bluetooth is supported in Google Chrome and Microsoft Edge on Android, Windows, and macOS. You can also print via the Browser Print (58mm) option!');
    return;
  }

  try {
    const statusLabel = document.getElementById('bt-status-label');
    if (statusLabel) statusLabel.innerHTML = 'Connecting...';

    const device = await navigator.bluetooth.requestDevice({
      acceptAllDevices: true,
      optionalServices: [
        '000018f0-0000-1000-8000-00805f9b34fb',
        'e7810a71-73ae-499d-8c15-faa9aef0c3f2',
        '49535343-fe7d-4ae5-8fa9-9fafd205e455',
        '0000ffe0-0000-1000-8000-00805f9b34fb',
        '0000af30-0000-1000-8000-00805f9b34fb'
      ]
    });

    device.addEventListener('gattserverdisconnected', onBluetoothDisconnected);
    const server = await device.gatt.connect();

    const services = await server.getPrimaryServices();
    let writeChar = null;
    for (const service of services) {
      const chars = await service.getCharacteristics();
      for (const ch of chars) {
        if (ch.properties.write || ch.properties.writeWithoutResponse) {
          writeChar = ch;
          break;
        }
      }
      if (writeChar) break;
    }

    if (!writeChar) {
      throw new Error('Could not find ESC/POS writable characteristic on selected Bluetooth printer.');
    }

    bluetoothPrinterDevice = device;
    bluetoothPrinterCharacteristic = writeChar;

    if (statusLabel) {
      statusLabel.innerHTML = `<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#16a34a;"></span> Connected: ${device.name || 'Thermal Printer'}`;
    }
    const connectBtn = document.getElementById('bt-connect-btn');
    if (connectBtn) {
      connectBtn.textContent = '✓ Connected';
      connectBtn.style.background = '#16a34a';
    }
    showToast(`✓ Connected to ${device.name || 'Bluetooth Printer'}`);
  } catch (err) {
    console.warn('Bluetooth connection cancelled or failed', err);
    const statusLabel = document.getElementById('bt-status-label');
    if (statusLabel) statusLabel.innerHTML = '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#dc2626;"></span> Pairing Failed / Cancelled';
    if (err.name !== 'NotFoundError') {
      alert(`Bluetooth pairing notice: ${err.message || err}. You can still use the 1-click Browser Print (58mm) slip!`);
    }
  }
}

function onBluetoothDisconnected() {
  bluetoothPrinterCharacteristic = null;
  const statusLabel = document.getElementById('bt-status-label');
  if (statusLabel) statusLabel.innerHTML = '<span style="display:inline-block; width:8px; height:8px; border-radius:50%; background:#94a3b8;"></span> Disconnected';
  const connectBtn = document.getElementById('bt-connect-btn');
  if (connectBtn) {
    connectBtn.textContent = '🔵 Pair Bluetooth Printer';
    connectBtn.style.background = '#2563eb';
  }
}

function generateEscPosBytes(customer, instNumber) {
  const bizName = (state.settings && state.settings.businessName) || 'JSR FINANCE';
  const phone = (state.settings && state.settings.operatorPhone) || '';
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const stats = getCustomerStats(customer);
  const inst = (customer.instalments || [])[instNumber - 1] || {};
  const isPart = inst.status === 'Partial';
  const paidAmt = isPart ? (inst.paidAmount || 0) : (customer.instalmentAmount || 0);
  const receiptNo = inst.receiptNumber || ('REC-' + now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0') + '-' + instNumber);

  const encoder = new TextEncoder();
  const parts = [];

  // ESC @: Initialize printer
  parts.push(new Uint8Array([0x1B, 0x40]));
  // ESC a 1: Center alignment
  parts.push(new Uint8Array([0x1B, 0x61, 0x01]));
  // GS ! 0x11: Double width & double height for header
  parts.push(new Uint8Array([0x1D, 0x21, 0x11]));
  parts.push(encoder.encode(`${bizName}\n`));
  // GS ! 0x00: Normal text
  parts.push(new Uint8Array([0x1D, 0x21, 0x00]));
  parts.push(encoder.encode(`Microfinance Collection Slip\n`));
  if (phone) parts.push(encoder.encode(`Helpline: ${phone}\n`));
  parts.push(encoder.encode(`--------------------------------\n`));

  // ESC a 0: Left alignment
  parts.push(new Uint8Array([0x1B, 0x61, 0x00]));
  parts.push(encoder.encode(`Rcpt #: ${receiptNo}\n`));
  parts.push(encoder.encode(`Date  : ${dateStr} ${timeStr}\n`));
  parts.push(encoder.encode(`Cust  : #${customer.customerNumber} - ${customer.fullName}\n`));
  parts.push(encoder.encode(`Loan  : Loan #${customer.loanNumber || 1} (${customer.frequency || 'Weekly'})\n`));
  parts.push(encoder.encode(`--------------------------------\n`));

  // ESC a 1: Center
  parts.push(new Uint8Array([0x1B, 0x61, 0x01]));
  parts.push(new Uint8Array([0x1D, 0x21, 0x01]));
  parts.push(encoder.encode(`RECEIVED: Rs. ${paidAmt}\n`));
  parts.push(new Uint8Array([0x1D, 0x21, 0x00]));

  // ESC a 0: Left
  parts.push(new Uint8Array([0x1B, 0x61, 0x00]));
  parts.push(encoder.encode(`Instalment   : #${instNumber} of ${customer.totalInstalments || 52}\n`));
  parts.push(encoder.encode(`Balance Due  : Rs. ${stats.balance}\n`));
  parts.push(encoder.encode(`Total Paid   : Rs. ${stats.totalPaid}\n`));
  parts.push(encoder.encode(`--------------------------------\n`));

  // ESC a 1: Center
  parts.push(new Uint8Array([0x1B, 0x61, 0x01]));
  parts.push(encoder.encode(`Thank You For Your Payment!\n`));
  parts.push(encoder.encode(`Keep this slip for your record\n\n\n\n`));
  parts.push(new Uint8Array([0x1D, 0x56, 0x00]));

  const totalLen = parts.reduce((acc, p) => acc + p.length, 0);
  const fullBytes = new Uint8Array(totalLen);
  let offset = 0;
  for (const p of parts) {
    fullBytes.set(p, offset);
    offset += p.length;
  }
  return fullBytes;
}

async function printThermalViaBluetooth() {
  if (!bluetoothPrinterCharacteristic) {
    await connectBluetoothPrinter();
    if (!bluetoothPrinterCharacteristic) return;
  }

  const customerId = state.activeThermalCustomerId;
  const instNumber = state.activeThermalInstNumber || 1;
  const c = state.customers.find(x => x.id === customerId);
  if (!c) {
    showToast('Customer record not found');
    return;
  }

  try {
    const bytes = generateEscPosBytes(c, instNumber);
    const chunkSize = 100;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const slice = bytes.slice(i, i + chunkSize);
      await bluetoothPrinterCharacteristic.writeValue(slice);
    }
    showToast('✓ Thermal receipt sent to Bluetooth printer!');
  } catch (err) {
    console.error('Failed to send bytes to Bluetooth printer', err);
    alert('Bluetooth print error: ' + (err.message || err));
  }
}

function printThermalSlipBrowser() {
  document.body.classList.add('printing-thermal');
  window.print();
  setTimeout(() => {
    document.body.classList.remove('printing-thermal');
  }, 1200);
}

function openThermalReceiptModal(customerId, instNumber) {
  const c = state.customers.find(x => x.id === customerId);
  if (!c) return;

  state.activeThermalCustomerId = customerId;
  state.activeThermalInstNumber = instNumber;

  const now = new Date();
  const dateStr = now.toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = now.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
  const bizName = (state.settings && state.settings.businessName) || 'JSR FINANCE';
  const bizPhone = (state.settings && state.settings.operatorPhone) || '9876543210';

  const stats = getCustomerStats(c);
  const inst = (c.instalments || [])[instNumber - 1] || {};
  const isPart = inst.status === 'Partial';
  const paidAmt = isPart ? (inst.paidAmount || 0) : (c.instalmentAmount || 0);
  const receiptNo = inst.receiptNumber || ('REC-' + now.getFullYear() + String(now.getMonth() + 1).padStart(2, '0') + String(now.getDate()).padStart(2, '0') + '-' + instNumber);

  const preview = document.getElementById('thermal-slip-preview');
  if (preview) {
    preview.innerHTML = `
      <h4>${bizName}</h4>
      <div class="thermal-sub">Microfinance Collection Receipt<br>Phone: ${bizPhone}</div>
      <div class="thermal-divider"></div>
      <div class="thermal-row"><span>Rcpt #:</span><span><strong>${receiptNo}</strong></span></div>
      <div class="thermal-row"><span>Date & Time:</span><span>${dateStr} ${timeStr}</span></div>
      <div class="thermal-row"><span>Customer:</span><span><strong>#${c.customerNumber} ${c.fullName}</strong></span></div>
      <div class="thermal-row"><span>Loan Acc:</span><span>Loan #${c.loanNumber || 1} (${c.frequency || 'Weekly'})</span></div>
      <div class="thermal-divider"></div>
      <div class="thermal-row-bold">
        <span>COLLECTED:</span>
        <span style="font-size: 15px;">₹ ${Number(paidAmt).toLocaleString('en-IN')}</span>
      </div>
      <div class="thermal-row"><span>Instalment #:</span><span>${instNumber} of ${c.totalInstalments || 52}</span></div>
      <div class="thermal-row"><span>Balance Remaining:</span><span>₹ ${stats.balance.toLocaleString('en-IN')}</span></div>
      <div class="thermal-row"><span>Total Paid:</span><span>₹ ${stats.totalPaid.toLocaleString('en-IN')}</span></div>
      <div class="thermal-divider"></div>
      <div style="text-align: center; font-size: 11px; margin-top: 6px;">
        ★ Thank You For Prompt Payment! ★<br>
        Authorized Field Agent Collection Slip
      </div>
      <div class="thermal-barcode">|||| | ||||| |||| || |||</div>
    `;
  }

  openModal('modal-thermal-slip');
}

// ========================================================
// PRO FEATURE 5: EARLY FORECLOSURE & SETTLEMENT WITH NOC
// ========================================================
function openSettlementModal(customerId) {
  const c = state.customers.find(x => x.id === customerId);
  if (!c) return;

  const stats = getCustomerStats(c);
  state.activeSettlementCustomerId = customerId;

  document.getElementById('settle-cust-id').value = customerId;
  document.getElementById('settle-disp-given').textContent = formatMoney(c.givenAmount);
  document.getElementById('settle-disp-paid').textContent = formatMoney(stats.totalPaid);
  document.getElementById('settle-disp-balance').textContent = formatMoney(stats.balance);
  document.getElementById('settle-input-amount').value = stats.balance;
  document.getElementById('settle-input-amount').max = stats.balance;
  document.getElementById('settle-input-date').value = getISTDateString();
  document.getElementById('settle-input-remarks').value = 'Full & Final lump-sum settlement agreed with proprietor';

  const card = document.getElementById('settle-customer-card');
  if (card) {
    card.innerHTML = `
      <div style="display: flex; justify-content: space-between; align-items: center;">
        <div>
          <strong style="font-size: 15px; color: #1e293b;">#${c.customerNumber} - ${c.fullName}</strong>
          <span class="loan-badge">L${c.loanNumber || 1}</span>
          <div style="font-size: 12px; color: #64748b; margin-top: 2px;">Phone: ${c.phone || 'N/A'} • Route: ${c.areaRoute || 'General'}</div>
        </div>
        <div style="text-align: right;">
          <div style="font-size: 11px; color: #64748b; font-weight: 700; text-transform: uppercase;">Disbursal Date</div>
          <strong style="font-size: 12.5px; color: #334155;">${c.startDate || 'N/A'}</strong>
        </div>
      </div>
    `;
  }

  updateSettlementCalc();
  openModal('modal-loan-settlement');
}

function updateSettlementCalc() {
  const customerId = state.activeSettlementCustomerId;
  const c = state.customers.find(x => x.id === customerId);
  if (!c) return;

  const stats = getCustomerStats(c);
  const settleAmt = Number(document.getElementById('settle-input-amount')?.value) || 0;
  const discount = Math.max(0, stats.balance - settleAmt);
  const discountPct = stats.balance > 0 ? Math.round((discount / stats.balance) * 100) : 0;

  const disp = document.getElementById('settle-disp-discount');
  if (disp) {
    disp.textContent = `₹ ${discount.toLocaleString('en-IN')} (${discountPct}%)`;
  }
}

async function handleSettlementSubmit(event) {
  event.preventDefault();
  const customerId = document.getElementById('settle-cust-id').value;
  const c = state.customers.find(x => x.id === customerId);
  if (!c) return;

  const stats = getCustomerStats(c);
  const settleAmt = Number(document.getElementById('settle-input-amount').value);
  const settleDate = document.getElementById('settle-input-date').value || getISTDateString();
  const paymentMode = document.getElementById('settle-input-mode').value || 'Cash';
  const remarks = document.getElementById('settle-input-remarks').value || 'Early Foreclosure Settlement';

  if (isNaN(settleAmt) || settleAmt < 0) {
    alert('Please enter a valid settlement amount.');
    return;
  }

  const discountWaived = Math.max(0, stats.balance - settleAmt);
  const nocNumber = `NOC-${new Date().getFullYear()}-${String(c.customerNumber).padStart(3, '0')}-L${c.loanNumber || 1}`;

  // Record audit transaction
  const receiptNo = generateUniqueReceiptNumber();
  if (settleAmt > 0) {
    recordTransaction({
      customerId: c.id,
      amount: settleAmt,
      instalmentNumber: stats.paidCount + 1,
      type: 'Foreclosure_Settlement',
      receiptNumber: receiptNo,
      notes: `Early settlement received (₹${discountWaived} waived as foreclosure discount). Payment mode: ${paymentMode}`
    });
  }

  // Update customer record
  c.isSettled = true;
  c.settlement = {
    settlementAmount: settleAmt,
    discountWaived,
    settledDate: settleDate,
    settledBy: (typeof getCurrentUser === 'function' ? getCurrentUser().name : 'Operator') || 'Owner',
    paymentMode,
    remarks,
    nocNumber,
    finalReceiptNumber: receiptNo
  };

  // Close remaining instalments
  (c.instalments || []).forEach(inst => {
    if (inst && inst.status !== 'Received') {
      inst.status = 'Received';
      inst.paidAmount = inst.paidAmount || 0;
      inst.isSettledWaived = true;
      inst.paidDate = settleDate;
      inst.receiptNumber = receiptNo;
    }
  });

  saveData();
  if (typeof syncCustomerToFirestore === 'function') {
    syncCustomerToFirestore(c);
  }

  closeModal('modal-loan-settlement');
  renderCustomersTable();
  renderCollectionMatrix();
  renderDashboard();
  renderAnalytics();

  showToast(`✓ Loan #${c.loanNumber || 1} settled! Official NOC ${nocNumber} generated.`);
  openNOCModal(c.id);
}

function openNOCModal(customerId) {
  const c = state.customers.find(x => x.id === customerId);
  if (!c || !c.settlement) return;

  state.activeNocCustomerId = customerId;

  const s = c.settlement;
  const bizName = (state.settings && state.settings.businessName) || 'JSR FINANCE';
  const dateFormatted = new Date(s.settledDate || getISTDateString()).toLocaleDateString('en-IN', {
    day: '2-digit',
    month: 'long',
    year: 'numeric'
  });

  const guarName = (c.guarantor && c.guarantor.name) ? c.guarantor.name : 'N/A';
  const container = document.getElementById('noc-certificate-container');
  if (container) {
    container.innerHTML = `
      <div class="noc-watermark">NO OBJECTION CERTIFICATE</div>
      <div class="noc-header">
        <div class="noc-title">${bizName}</div>
        <div class="noc-subtitle">Microfinance & Rural Enterprise Credit Division</div>
      </div>

      <div class="noc-cert-meta">
        <div><strong>Certificate No:</strong> ${s.nocNumber}</div>
        <div><strong>Date of Clearance:</strong> ${dateFormatted}</div>
      </div>

      <div class="noc-body-text">
        This is to formally certify that <strong>${c.fullName}</strong>, bearing Customer Account <strong>#${c.customerNumber}</strong>, 
        residing at <em>${c.address || 'Registered Address'}</em>, has fully and satisfactorily paid, cleared, and settled all dues, 
        principal, interest margin, and obligations towards <strong>Loan Account #${c.customerNumber}-L${c.loanNumber || 1}</strong> 
        originally disbursed on <strong>${c.startDate || 'N/A'}</strong>.
        <br><br>
        As of <strong>${dateFormatted}</strong>, there is <strong>ABSOLUTELY ZERO (₹ 0) OUTSTANDING BALANCE</strong>, claim, or encumbrance 
        remaining against the aforementioned borrower. Any surety, guarantee, or obligation undertaken by the registered Guarantor 
        (<strong>${guarName}</strong>) also stands fully and irrevocably released, discharged, and nullified.
      </div>

      <div class="noc-terms-grid">
        <div><span style="color:#64748b; font-size:11px;">Original Disbursal:</span><br><strong>${formatMoney(c.givenAmount)}</strong></div>
        <div><span style="color:#64748b; font-size:11px;">Settlement Amount Paid:</span><br><strong style="color:#15803d;">${formatMoney(s.settlementAmount)}</strong></div>
        <div><span style="color:#64748b; font-size:11px;">Rebate / Discount Waived:</span><br><strong style="color:#7c3aed;">${formatMoney(s.discountWaived)}</strong></div>
        <div><span style="color:#64748b; font-size:11px;">Closure Status:</span><br><strong style="color:#166534;">✓ FULL & FINAL SETTLED</strong></div>
      </div>

      <div class="noc-signatures">
        <div class="noc-sign-box">
          <div class="noc-sign-line"></div>
          <div style="font-size: 12px; font-weight: 700; color: #0f172a;">Borrower Signature</div>
          <div style="font-size: 11px; color: #64748b;">${c.fullName}</div>
        </div>

        <div class="noc-seal-emblem">
          <div>★ JSR ★</div>
          <div>ACCOUNT</div>
          <div>CLEARED</div>
          <div style="font-size: 8px;">NOC GRANTED</div>
        </div>

        <div class="noc-sign-box">
          <div class="noc-sign-line"></div>
          <div style="font-size: 12px; font-weight: 700; color: #0f172a;">Authorized Signatory</div>
          <div style="font-size: 11px; color: #64748b;">${bizName}</div>
        </div>
      </div>
    `;
  }

  const waBtn = document.getElementById('noc-whatsapp-btn');
  if (waBtn) {
    waBtn.onclick = () => shareNOCWhatsApp(customerId);
  }

  openModal('modal-noc');
}

function printNOCCertificate() {
  document.body.classList.add('printing-noc');
  window.print();
  setTimeout(() => {
    document.body.classList.remove('printing-noc');
  }, 1200);
}

function shareNOCWhatsApp(customerId) {
  const c = state.customers.find(x => x.id === customerId);
  if (!c || !c.settlement) return;

  const bizName = (state.settings && state.settings.businessName) || 'JSR Finance';
  const cleanPhone = formatWhatsAppPhone(c.phone);
  const s = c.settlement;

  const msg = encodeURIComponent(
    `*${bizName} - NO OBJECTION CERTIFICATE (NOC)*\n\n` +
    `Dear ${c.fullName},\n` +
    `Congratulations! Your Loan Account *#${c.customerNumber}-L${c.loanNumber || 1}* has been *FULLY SETTLED & CLOSED*.\n\n` +
    `*NOC Certificate Number:* ${s.nocNumber}\n` +
    `*Cleared Date:* ${s.settledDate}\n` +
    `*Settlement Amount Paid:* ${formatMoney(s.settlementAmount)}\n` +
    `*Remaining Balance:* ₹ 0 (NIL)\n\n` +
    `Thank you for being a valued customer with ${bizName}!`
  );

  window.open(`https://wa.me/${cleanPhone}?text=${msg}`, '_blank');
}

// Helper: Sanitize corrupted years (e.g. +046316-02-18 or 46315 -> 2025/2026)
function sanitizeDateYear(dateStr) {
  if (!dateStr || dateStr === '-') return '';
  let str = String(dateStr).trim();
  if (str.startsWith('+')) str = str.slice(1);

  // Match YYYY-MM-DD or YYYYY-MM-DD or YYYYYY-MM-DD
  const m = str.match(/^0*(\d{4,6})[\/\-](\d{1,2})[\/\-](\d{1,2})(.*)$/);
  if (m) {
    let year = parseInt(m[1], 10);
    const month = m[2].padStart(2, '0');
    const day = m[3].padStart(2, '0');
    const rest = m[4] || '';

    // If year was corrupted by Excel serial date offset (e.g. 46315 -> 2025, 46316 -> 2026)
    if (year >= 40000 && year <= 60000) {
      year = year - 44290;
    } else if (year > 2100) {
      year = 2026;
    }
    return `${year}-${month}-${day}${rest}`;
  }
  return str;
}

// Helper: Format Dates consistently (YYYY-MM-DD -> DD/MM/YYYY or DD/MM/YY)
function formatPassbookDate(dateStr, isCompact = false) {
  if (!dateStr || dateStr === '-') return '-';
  const cleanStr = sanitizeDateYear(dateStr);
  const parts = cleanStr.split(/[\/\-]/);
  if (parts.length >= 3) {
    let y = parts[0], m = parts[1], d = parts[2];
    if (d.length === 4) {
      const temp = y; y = d; d = temp;
    }
    d = d.split(' ')[0].split('T')[0];
    if (y.length === 4) {
      return isCompact ? `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y.slice(2)}` : `${d.padStart(2, '0')}/${m.padStart(2, '0')}/${y}`;
    }
  }

  const dt = new Date(cleanStr);
  if (!isNaN(dt.getTime())) {
    const d = String(dt.getDate()).padStart(2, '0');
    const m = String(dt.getMonth() + 1).padStart(2, '0');
    const y = String(dt.getFullYear());
    return isCompact ? `${d}/${m}/${y.slice(2)}` : `${d}/${m}/${y}`;
  }
  return cleanStr;
}

// ----------------------------------------------------
// CUSTOMER PASSBOOK / LEDGER MODAL
// ----------------------------------------------------
function openCustomerPassbook(customerId) {
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  state.activePassbookCustomerId = customerId;

  const stats = getCustomerStats(c);
  const totalInst = c.totalInstalments || 52;
  const isDaily = c.frequency === 'Daily' || totalInst === 100;
  const unitLabel = isDaily ? 'Day' : 'Week';
  const unitRate = isDaily ? '/day' : '/wk';
  const planBadge = isDaily 
    ? '<span style="background:#fef3c7; color:#b45309; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700;">100-Day Daily Plan</span>'
    : `<span style="background:#eff6ff; color:#1d4ed8; padding:2px 8px; border-radius:4px; font-size:11px; font-weight:700;">${totalInst}-Week Plan</span>`;

  const loanSuffix = (c.loanNumber && c.loanNumber > 1) ? ` (Loan #${c.loanNumber})` : '';
  const loanBadgeHtml = (c.loanNumber && c.loanNumber > 1) ? ` <span class="loan-badge">L${c.loanNumber}</span>` : '';

  const customerLoans = state.customers.filter((x) => x.customerNumber.toString() === c.customerNumber.toString());
  let loanSwitcherHtml = '';
  if (customerLoans.length > 1) {
    loanSwitcherHtml = `
      <div style="display:flex; gap:8px; margin-bottom:14px; background:#e2e8f0; padding:4px; border-radius:8px;">
        ${customerLoans.map((loan, idx) => {
          const isSelected = loan.id === customerId;
          const loanStats = getCustomerStats(loan);
          return `
            <button type="button" class="btn ${isSelected ? 'btn-primary' : 'btn-outline'}" 
                    style="flex:1; font-size:12px; padding:6px 10px; background:${isSelected ? '#2563eb' : '#ffffff'}; color:${isSelected ? '#ffffff' : '#1e293b'}; border:1px solid ${isSelected ? '#1d4ed8' : '#cbd5e1'};" 
                    onclick="openCustomerPassbook('${loan.id}')">
              💳 Loan #${loan.loanNumber || (idx + 1)} (${formatMoney(loan.givenAmount)}) ${loanStats.isCompleted ? '✓ Done' : `(Bal ${formatMoney(loanStats.balance)})`}
            </button>
          `;
        }).join('')}
      </div>
    `;
  }

  const rating = calculateCreditRating(c);
  const guar = c.guarantor || {};
  const photoHtml = c.photoUrl
    ? `<img src="${c.photoUrl}" style="width: 48px; height: 48px; border-radius: 50%; object-fit: cover; border: 2px solid #2563eb; flex-shrink: 0;">`
    : `<div style="width: 48px; height: 48px; border-radius: 50%; background: #e2e8f0; display: flex; align-items: center; justify-content: center; font-size: 20px; flex-shrink: 0;">👤</div>`;

  const kycHtml = c.kycVerified
    ? `<span class="kyc-badge" onclick="openKycViewerModal('${c.id}')" title="KYC Verified - Click to view">✓ KYC Verified</span>`
    : `<span class="kyc-badge kyc-badge-unverified" onclick="openKycViewerModal('${c.id}')" title="Pending KYC - Click to view">KYC Pending</span>`;

  document.getElementById('passbook-modal-title').textContent = `Customer Passbook - #${c.customerNumber}${loanSuffix}: ${c.fullName}`;
  document.getElementById('passbook-header-info').innerHTML = `
    ${loanSwitcherHtml}
    <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:10px; background:#eff6ff; border:1px solid #bfdbfe; border-radius:8px; padding:10px 14px; margin-bottom:12px;">
      <div style="display:flex; align-items:center; gap:12px;">
        ${photoHtml}
        <div>
          <div style="font-size:15px; font-weight:800; color:#1e293b;">
            #${c.customerNumber}${loanBadgeHtml} - ${c.fullName}
          </div>
          <div style="display:flex; align-items:center; gap:8px; margin-top:2px; flex-wrap:wrap;">
            <span class="credit-badge ${rating.badgeClass}">⭐ ${rating.stars} ${rating.tier}</span>
            ${kycHtml}
            ${c.isSettled ? `<span class="badge-settled" onclick="openNOCModal('${c.id}')">🤝 Settled (NOC #${c.settlement?.nocNumber || 'Issued'})</span>` : ''}
          </div>
        </div>
      </div>
      <div style="display:flex; gap:6px; flex-wrap:wrap;">
        <button type="button" class="btn btn-outline btn-sm" onclick="openThermalReceiptModal('${c.id}', ${stats.paidCount > 0 ? stats.paidCount : 1})" title="Print 58mm Pocket Thermal Slip">
          🖨️ Pocket Thermal Slip
        </button>
        ${!c.isSettled && stats.balance > 0 ? `
          <button type="button" class="btn btn-sm" style="background:#7c3aed; color:#fff; font-weight:700;" onclick="openSettlementModal('${c.id}')">
            🤝 Early Settle & NOC
          </button>
        ` : (c.isSettled ? `
          <button type="button" class="btn btn-sm" style="background:#d97706; color:#fff; font-weight:700;" onclick="openNOCModal('${c.id}')">
            📜 View Official NOC
          </button>
        ` : '')}
      </div>
    </div>

    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; background:#f1f5f9; padding:14px; border-radius:8px; margin-bottom:16px;">
      <div><span style="color:#64748b; font-size:12px;">Phone:</span><br><strong>${c.phone || 'N/A'}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Given Principal:</span><br><strong style="color:#1e3a8a;">${formatMoney(c.givenAmount)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Instalment:</span><br><strong>${formatMoney(c.instalmentAmount)} ${unitRate}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Total Repayable:</span><br><strong style="color:#1e293b;">${formatMoney(stats.totalPayable)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Total Paid:</span><br><strong style="color:#16a34a;">${formatMoney(stats.totalPaid)} (${stats.paidCount}/${totalInst})</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Balance Due:</span><br><strong style="color:#b45309;">${formatMoney(stats.balance)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Plan Frequency:</span><br>${planBadge}</div>
      <div>
        <span style="color:#64748b; font-size:12px;">Guarantor / Surety:</span><br>
        <strong>${guar.name ? `${guar.name} (${guar.rel || 'Guarantor'})` : 'None'}</strong>
        ${guar.phone ? `<button type="button" class="btn btn-sm btn-outline" style="padding:1px 5px; font-size:10px; margin-left:4px; color:#16a34a;" onclick="contactGuarantor('${c.id}', 'whatsapp')">💬 WA</button>` : ''}
      </div>
      <div><span style="color:#64748b; font-size:12px;">Status:</span><br><span class="badge-status ${stats.isCompleted ? 'badge-status-completed' : 'badge-status-active'}">${stats.isCompleted ? 'Completed' : 'Active'}</span></div>
    </div>
  `;

  // Render rows dynamically for all instalments
  const tbody = document.getElementById('passbook-table-body');
  let rowsHtml = '';
  for (let w = 1; w <= totalInst; w++) {
    const inst = (c.instalments && c.instalments[w - 1]) || { number: w, status: 'Pending' };
    const isReceived = inst.status === 'Received';
    const isPartial = inst.status === 'Partial';

    rowsHtml += `
      <tr>
        <td><strong>${unitLabel} #${w}</strong></td>
        <td>${formatMoney(c.instalmentAmount)}</td>
        <td>
          ${isReceived
            ? `<span class="badge-status badge-status-success">✓ Received (${formatMoney(inst.paidAmount || c.instalmentAmount)})</span>`
            : (isPartial
                ? `<span class="badge-status badge-status-partial" title="Pending Instalment Amount: ${formatMoney(Math.max(0, (c.instalmentAmount || 0) - (Number(inst.paidAmount) || 0)))}">½ Partial (Paid: ${formatMoney(inst.paidAmount)} | Pending: ${formatMoney(Math.max(0, (c.instalmentAmount || 0) - (Number(inst.paidAmount) || 0)))})</span>`
                : `<span style="color:#94a3b8;">Pending</span>`)}
        </td>
        <td>${formatPassbookDate(inst.paidDate) || '-'}</td>
        <td>${inst.receiptNumber || '-'}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="toggleInstalmentReceived('${c.id}', ${w}); openCustomerPassbook('${c.id}');">
            ${isReceived ? 'Undo' : (isPartial ? `Pay Pending ${formatMoney(Math.max(0, (c.instalmentAmount || 0) - (Number(inst.paidAmount) || 0)))}` : 'Mark Received')}
          </button>
        </td>
      </tr>
    `;
  }
  tbody.innerHTML = rowsHtml;

  // Setup WhatsApp share button
  const shareBtn = document.getElementById('passbook-whatsapp-btn');
  const msg = encodeURIComponent(
    `*${state.settings.businessName}*\nCustomer: #${c.customerNumber}${loanSuffix} - ${c.fullName}\nPlan: ${isDaily ? '100-Day Daily Plan' : totalInst + '-Week Plan'}\nGiven Amount: ${formatMoney(c.givenAmount)}\nInstalment: ${formatMoney(c.instalmentAmount)} ${unitRate}\nInstalments Paid: ${stats.paidCount}/${totalInst}\nTotal Paid: ${formatMoney(stats.totalPaid)}\nBalance Remaining: ${formatMoney(stats.balance)}\nThank you!`
  );
  shareBtn.onclick = () => window.open(`https://wa.me/${formatWhatsAppPhone(c.phone)}?text=${msg}`, '_blank');

  openModal('modal-passbook');
}

// ----------------------------------------------------
// PRINT OFFICIAL CUSTOMER PASSBOOK / LEDGER STATEMENT
// ----------------------------------------------------
function printCustomerPassbook(customerId) {
  const targetId = customerId || state.activePassbookCustomerId;
  const c = state.customers.find((cust) => cust.id === targetId);
  if (!c) {
    showToast('Please select or open a customer passbook first.');
    return;
  }

  const stats = getCustomerStats(c);
  const totalInst = c.totalInstalments || 52;
  const isDaily = c.frequency === 'Daily' || totalInst === 100;
  const unitLabel = isDaily ? 'Day' : 'Week';
  const unitRate = isDaily ? '/day' : '/wk';
  const planName = isDaily ? '100-Day Daily Plan' : `${totalInst}-Week Weekly Plan`;
  const loanNumber = c.loanNumber || 1;
  const loanSuffix = loanNumber > 1 ? ` (Loan #${loanNumber})` : '';

  const todayStr = new Date().toLocaleDateString('en-IN', {
    weekday: 'short',
    day: '2-digit',
    month: 'short',
    year: 'numeric'
  });
  const timeStr = new Date().toLocaleTimeString('en-IN', {
    hour: '2-digit',
    minute: '2-digit'
  });

  const printWindow = window.open('', '_blank', 'width=900,height=950');
  if (!printWindow) {
    // Fallback: If popup is blocked by browser, trigger in-page passbook printing via CSS
    document.body.classList.add('printing-passbook');
    window.print();
    setTimeout(() => {
      document.body.classList.remove('printing-passbook');
    }, 1500);
    return;
  }

  // Generate table columns based on totalInstalments
  let tableHtml = '';
  if (totalInst === 100) {
    // 4 columns of 25 rows for 100-Day plan (compact A4 fit)
    const colSize = 25;
    let rows = '';
    for (let r = 1; r <= colSize; r++) {
      rows += '<tr>';
      for (let col = 0; col < 4; col++) {
        const w = r + col * colSize;
        if (col > 0) {
          rows += '<td style="width:6px; border:none; background:#fff;"></td>';
        }
        if (w <= totalInst) {
          const inst = (c.instalments && c.instalments[w - 1]) || { number: w, status: 'Pending' };
          const isRec = inst.status === 'Received';
          const isPart = inst.status === 'Partial';
          const stLabel = isRec ? 'PAID' : (isPart ? 'PART' : 'DUE');
          const stColor = isRec ? '#15803d' : (isPart ? '#b45309' : '#64748b');
          const amt = isPart ? (inst.paidAmount || 0) : (c.instalmentAmount || 0);
          const dt = formatPassbookDate(inst.paidDate, true);
          rows += `
            <td style="text-align:center; font-weight:700; background:#f8fafc; border:1px solid #cbd5e1; padding:2px 3px; font-size:10px;">${w}</td>
            <td style="text-align:right; border:1px solid #cbd5e1; padding:2px 3px; font-size:10px; font-weight:600;">₹${amt}</td>
            <td style="text-align:center; border:1px solid #cbd5e1; padding:2px 3px; font-size:9px;">${dt}</td>
            <td style="text-align:center; border:1px solid #cbd5e1; padding:2px 3px; font-size:9px; font-weight:700; color:${stColor};">${stLabel}</td>
          `;
        } else {
          rows += '<td colspan="4" style="border:none;"></td>';
        }
      }
      rows += '</tr>';
    }

    tableHtml = `
      <table style="width:100%; border-collapse:collapse; margin-top:8px;">
        <thead>
          <tr style="background:#0f172a; color:#fff; font-size:10px;">
            <th style="padding:4px 2px; border:1px solid #0f172a;">Day</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Amt</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Date</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">St</th>
            <th style="width:6px; border:none; background:#fff;"></th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Day</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Amt</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Date</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">St</th>
            <th style="width:6px; border:none; background:#fff;"></th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Day</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Amt</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Date</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">St</th>
            <th style="width:6px; border:none; background:#fff;"></th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Day</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Amt</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">Date</th>
            <th style="padding:4px 2px; border:1px solid #0f172a;">St</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  } else {
    // 2 columns of 26 rows for 52-Week standard plans
    const colSize = Math.ceil(totalInst / 2);
    let rows = '';
    for (let r = 1; r <= colSize; r++) {
      const leftW = r;
      const rightW = r + colSize;

      const renderCol = (w) => {
        if (w > totalInst) return '<td colspan="5" style="border:none;"></td>';
        const inst = (c.instalments && c.instalments[w - 1]) || { number: w, status: 'Pending' };
        const isRec = inst.status === 'Received';
        const isPart = inst.status === 'Partial';
        const stLabel = isRec ? '✓ RECEIVED' : (isPart ? '½ PARTIAL' : 'PENDING');
        const stColor = isRec ? '#166534' : (isPart ? '#b45309' : '#64748b');
        const stBg = isRec ? '#f0fdf4' : (isPart ? '#fffbeb' : '#fff');
        const amt = isPart ? `₹ ${(inst.paidAmount || 0).toLocaleString('en-IN')}` : `₹ ${(c.instalmentAmount || 0).toLocaleString('en-IN')}`;
        const dt = formatPassbookDate(inst.paidDate, false);
        const rcpt = inst.receiptNumber ? `#${inst.receiptNumber}` : '-';

        return `
          <td style="text-align:center; font-weight:700; background:#f8fafc; border:1px solid #cbd5e1; padding:3px 4px; font-size:11px;">${unitLabel} #${w}</td>
          <td style="text-align:right; border:1px solid #cbd5e1; padding:3px 4px; font-size:11px; font-weight:600;">${amt}</td>
          <td style="text-align:center; border:1px solid #cbd5e1; padding:3px 4px; font-size:10px;">${dt}</td>
          <td style="text-align:center; border:1px solid #cbd5e1; padding:3px 4px; font-size:10px;">${rcpt}</td>
          <td style="text-align:center; border:1px solid #cbd5e1; padding:3px 4px; font-size:10px; font-weight:700; background:${stBg}; color:${stColor};">${stLabel}</td>
        `;
      };

      rows += `
        <tr>
          ${renderCol(leftW)}
          <td style="width:10px; border:none; background:#fff;"></td>
          ${renderCol(rightW)}
        </tr>
      `;
    }

    tableHtml = `
      <table style="width:100%; border-collapse:collapse; margin-top:8px;">
        <thead>
          <tr style="background:#0f172a; color:#fff; font-size:11px;">
            <th style="padding:4px; border:1px solid #0f172a;">Week</th>
            <th style="padding:4px; border:1px solid #0f172a; text-align:right;">Inst. Amt</th>
            <th style="padding:4px; border:1px solid #0f172a;">Paid Date</th>
            <th style="padding:4px; border:1px solid #0f172a;">Receipt #</th>
            <th style="padding:4px; border:1px solid #0f172a;">Status</th>
            <th style="width:10px; border:none; background:#fff;"></th>
            <th style="padding:4px; border:1px solid #0f172a;">Week</th>
            <th style="padding:4px; border:1px solid #0f172a; text-align:right;">Inst. Amt</th>
            <th style="padding:4px; border:1px solid #0f172a;">Paid Date</th>
            <th style="padding:4px; border:1px solid #0f172a;">Receipt #</th>
            <th style="padding:4px; border:1px solid #0f172a;">Status</th>
          </tr>
        </thead>
        <tbody>
          ${rows}
        </tbody>
      </table>
    `;
  }

  const businessName = state.settings.businessName || 'JSR FINANCE';
  const businessPhone = state.settings.phone || '';
  const businessAddress = state.settings.address || '';

  printWindow.document.write(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>Passbook - #${c.customerNumber}${loanSuffix} ${c.fullName}</title>
      <style>
        @page {
          size: A4 portrait;
          margin: 8mm;
        }
        * {
          box-sizing: border-box;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        body {
          font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
          color: #0f172a;
          background: #fff;
          margin: 0;
          padding: 6px;
          font-size: 11px;
        }
        .passbook-container {
          max-width: 800px;
          margin: 0 auto;
          border: 2px solid #0f172a;
          padding: 12px;
          border-radius: 6px;
        }
        .header {
          display: flex;
          justify-content: space-between;
          align-items: flex-start;
          border-bottom: 2px solid #0f172a;
          padding-bottom: 8px;
          margin-bottom: 8px;
        }
        .business-title {
          font-size: 20px;
          font-weight: 800;
          color: #0f172a;
          letter-spacing: 0.5px;
        }
        .business-sub {
          font-size: 11px;
          color: #475569;
          margin-top: 2px;
        }
        .doc-badge {
          text-align: right;
        }
        .doc-title {
          font-size: 14px;
          font-weight: 800;
          color: #1e3a8a;
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .doc-meta {
          font-size: 10px;
          color: #64748b;
          margin-top: 2px;
        }
        .summary-card {
          display: grid;
          grid-template-columns: repeat(4, 1fr);
          gap: 6px;
          background: #f8fafc;
          border: 1px solid #cbd5e1;
          border-radius: 6px;
          padding: 8px 10px;
          margin-bottom: 8px;
        }
        .info-cell {
          font-size: 11px;
        }
        .info-label {
          color: #64748b;
          font-size: 10px;
          display: block;
          margin-bottom: 2px;
        }
        .info-val {
          font-weight: 700;
          color: #0f172a;
        }
        .badge-status {
          display: inline-block;
          padding: 2px 6px;
          border-radius: 4px;
          font-size: 10px;
          font-weight: 700;
        }
        .status-active {
          background: #dbeafe;
          color: #1d4ed8;
        }
        .status-completed {
          background: #dcfce7;
          color: #15803d;
        }
        .financial-bar {
          display: flex;
          justify-content: space-between;
          background: #0f172a;
          color: #fff;
          padding: 6px 12px;
          border-radius: 4px;
          font-size: 11px;
          font-weight: 700;
          margin-bottom: 6px;
        }
        .financial-bar span {
          display: flex;
          gap: 6px;
        }
        .financial-bar .num {
          color: #38bdf8;
        }
        .signature-area {
          display: flex;
          justify-content: space-between;
          margin-top: 18px;
          padding-top: 22px;
          border-top: 1px dashed #94a3b8;
        }
        .sign-box {
          text-align: center;
          width: 180px;
          border-top: 1px solid #0f172a;
          padding-top: 4px;
          font-size: 10px;
          font-weight: 700;
          color: #334155;
        }
        .footer-note {
          text-align: center;
          font-size: 9px;
          color: #94a3b8;
          margin-top: 10px;
        }
      </style>
    </head>
    <body>
      <div class="passbook-container">
        <!-- Business Header -->
        <div class="header">
          <div>
            <div class="business-title">${businessName}</div>
            <div class="business-sub">${businessAddress}${businessAddress && businessPhone ? ' | ' : ''}${businessPhone}</div>
          </div>
          <div class="doc-badge">
            <div class="doc-title">Loan Passbook Statement</div>
            <div class="doc-meta">Printed: ${todayStr} ${timeStr}</div>
          </div>
        </div>

        <!-- Customer & Loan Account Info -->
        <div class="summary-card" style="grid-template-columns: 2fr 1fr 1fr 1fr;">
          <div class="info-cell" style="display:flex; align-items:center; gap:8px;">
            ${c.photoUrl ? `<img src="${c.photoUrl}" style="width:40px; height:40px; border-radius:50%; object-fit:cover; border:2px solid #0f172a; flex-shrink:0;" alt="Borrower">` : ''}
            <div>
              <span class="info-label">Customer ID & Name:</span>
              <span class="info-val">#${c.customerNumber}${loanSuffix} - ${c.fullName}</span>
              <div style="font-size:10px; color:#475569; margin-top:2px;">
                ⭐ Credit: <strong>${stats.creditRating?.stars || '⭐⭐⭐⭐⭐'} (${stats.creditRating?.score?.toFixed(1) || '5.0'})</strong>
                ${c.kycVerified ? ' • <span style="color:#15803d; font-weight:700;">✓ KYC Verified</span>' : ''}
              </div>
            </div>
          </div>
          <div class="info-cell">
            <span class="info-label">Phone & Surety:</span>
            <span class="info-val">${c.phone || 'N/A'}</span>
            ${c.guarantorName ? `<div style="font-size:10px; color:#475569; margin-top:2px;">Surety: <strong>${c.guarantorName}</strong> (${c.guarantorPhone || 'N/A'})</div>` : ''}
          </div>
          <div class="info-cell">
            <span class="info-label">Loan Plan:</span>
            <span class="info-val">${planName}</span>
            <div style="font-size:10px; color:#475569; margin-top:2px;">Route: ${c.areaRoute || 'General'}</div>
          </div>
          <div class="info-cell">
            <span class="info-label">Loan Status:</span>
            ${c.isSettled 
              ? `<span class="badge-status" style="background:#ecfdf5; color:#059669; border:1px solid #a7f3d0;">🤝 SETTLED (NOC ISSUED)</span>` 
              : `<span class="badge-status ${stats.isCompleted ? 'status-completed' : 'status-active'}">${stats.isCompleted ? 'COMPLETED' : 'ACTIVE'}</span>`
            }
          </div>
          <div class="info-cell">
            <span class="info-label">Principal Given:</span>
            <span class="info-val" style="color:#1d4ed8;">₹ ${Number(c.givenAmount).toLocaleString('en-IN')}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">Instalment Rate:</span>
            <span class="info-val">₹ ${Number(c.instalmentAmount).toLocaleString('en-IN')} ${unitRate}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">Total Repayable:</span>
            <span class="info-val">₹ ${Number(stats.totalPayable).toLocaleString('en-IN')}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">Start / Issue Date:</span>
            <span class="info-val">${formatPassbookDate(c.startDate, false) || 'N/A'}</span>
          </div>
        </div>

        <!-- Financial Summary Bar -->
        <div class="financial-bar">
          <span>Total Paid: <span class="num">₹ ${Number(stats.totalPaid).toLocaleString('en-IN')}</span> (${stats.paidCount}/${totalInst})</span>
          <span>Balance Outstanding: <span class="num" style="color:#f87171;">₹ ${Number(stats.balance).toLocaleString('en-IN')}</span></span>
          <span>Progress: <span class="num">${Math.min(100, Math.round((stats.totalPaid / (stats.totalPayable || 1)) * 100))}%</span></span>
        </div>

        <!-- Chronological Repayment Ledger -->
        ${tableHtml}

        <!-- Signatures -->
        <div class="signature-area">
          <div class="sign-box">Customer Signature</div>
          <div class="sign-box">Agent / Collector Signature</div>
          <div class="sign-box">Authorized Cashier / Manager</div>
        </div>

        <div class="footer-note">
          Official repayment record issued by ${businessName}. Please preserve this passbook for your payment verification.
        </div>
      </div>

      <script>
        window.onload = function() {
          window.focus();
          setTimeout(function() {
            window.print();
          }, 250);
        };
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
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
function applyScreenZoom(zoomVal) {
  try {
    const zoomSelect = document.getElementById('setting-screen-zoom');
    const zoom = zoomVal || (zoomSelect ? zoomSelect.value : (state.settings && state.settings.screenZoom)) || '100%';
    if (zoomSelect && !zoomVal) {
      zoomSelect.value = zoom;
    }
    if (zoom && zoom !== '100%') {
      document.documentElement.style.zoom = zoom;
    }
  } catch (e) {
    console.warn('Zoom not supported', e);
  }
}

function renderSettings() {
  document.getElementById('setting-business-name').value = state.settings.businessName;
  document.getElementById('setting-phone').value = state.settings.phone;
  document.getElementById('setting-address').value = state.settings.address;
  document.getElementById('setting-currency').value = state.settings.currency;
  document.getElementById('setting-default-given').value = state.settings.defaultGivenAmount;
  const minGivenInput = document.getElementById('setting-min-given');
  if (minGivenInput) {
    minGivenInput.value = state.settings.minGivenAmount ?? 1000;
  }
  document.getElementById('setting-default-instalments').value = state.settings.defaultInstalments;
  document.getElementById('setting-default-inst-amount').value = state.settings.defaultInstalmentAmount;
  
  const adminEmailInput = document.getElementById('setting-admin-email');
  if (adminEmailInput) {
    adminEmailInput.value = state.settings.adminEmail || 'singarisurendra@gmail.com';
  }

  const whitelistInput = document.getElementById('setting-operator-whitelist');
  if (whitelistInput) {
    whitelistInput.value = state.settings.operatorWhitelist || '';
  }

  renderCollectorsRoster();
  applyScreenZoom();
  updateSoundToggleButton();

  const sessIdElem = document.getElementById('settings-session-id');
  if (sessIdElem) sessIdElem.textContent = window.CURRENT_SESSION_ID || 'session_active';
  const fbBadge = document.getElementById('settings-firebase-badge');
  if (fbBadge) {
    if (typeof isCloudSyncActive !== 'undefined' && isCloudSyncActive && typeof firestoreDb !== 'undefined' && firestoreDb) {
      fbBadge.style.background = '#dcfce7';
      fbBadge.style.color = '#15803d';
      fbBadge.style.borderColor = '#86efac';
      fbBadge.textContent = '● Live Connected (Google Cloud)';
    } else {
      fbBadge.style.background = '#fef2f2';
      fbBadge.style.color = '#dc2626';
      fbBadge.style.borderColor = '#fca5a5';
      fbBadge.textContent = '○ Local / Offline Mode';
    }
  }
}

function handleSaveSettings(event) {
  event.preventDefault();

  state.settings.businessName = document.getElementById('setting-business-name').value.trim() || 'JSR Finance';
  state.settings.phone = document.getElementById('setting-phone').value.trim();
  state.settings.address = document.getElementById('setting-address').value.trim();
  state.settings.currency = document.getElementById('setting-currency').value.trim() || '₹';
  state.settings.defaultGivenAmount = Number(document.getElementById('setting-default-given').value) || 10000;
  const minGivenEl = document.getElementById('setting-min-given');
  state.settings.minGivenAmount = (minGivenEl && !isNaN(minGivenEl.value) && Number(minGivenEl.value) > 0)
    ? Number(minGivenEl.value)
    : 1000;
  state.settings.defaultInstalments = Number(document.getElementById('setting-default-instalments').value) || 52;
  state.settings.defaultInstalmentAmount = Number(document.getElementById('setting-default-inst-amount').value) || 200;

  const adminEmailInput = document.getElementById('setting-admin-email');
  if (adminEmailInput) {
    state.settings.adminEmail = adminEmailInput.value.trim().toLowerCase() || 'singarisurendra@gmail.com';
  }

  const whitelistInput = document.getElementById('setting-operator-whitelist');
  if (whitelistInput) {
    state.settings.operatorWhitelist = whitelistInput.value.trim();
  }

  const zoomSelect = document.getElementById('setting-screen-zoom');
  if (zoomSelect) applyScreenZoom(zoomSelect.value);

  saveData();
  if (typeof syncSettingsToFirestore === 'function') {
    syncSettingsToFirestore(state.settings);
  }
  updateHeaderStats();
  showToast('Settings saved and synced to Google Cloud Firestore!');
}

// Export Data as JSON Backup
function exportDataBackup() {
  const exportObject = {
    exportDate: new Date().toISOString(),
    version: '1.0',
    settings: state.settings,
    schemes: state.schemes,
    customers: state.customers,
    transactions: state.transactions || [],
  };

  const dataStr = 'data:text/json;charset=utf-8,' + encodeURIComponent(JSON.stringify(exportObject, null, 2));
  const downloadAnchor = document.createElement('a');
  downloadAnchor.setAttribute('href', dataStr);
  downloadAnchor.setAttribute('download', `JSR_Finance_Backup_${getISTDateString()}.json`);
  document.body.appendChild(downloadAnchor);
  downloadAnchor.click();
  downloadAnchor.remove();
}

// Import JSON Backup
function importDataBackup(event) {
  const file = event.target.files[0];
  if (!file) return;

  const reader = new FileReader();
  reader.onload = async function (e) {
    try {
      const imported = JSON.parse(e.target.result);
      if (imported.customers && imported.settings) {
        state.settings = imported.settings;
        state.customers = imported.customers;
        if (imported.schemes) state.schemes = imported.schemes;
        if (imported.transactions) state.transactions = imported.transactions;
        saveData();

        // Push restored data to Cloud Firestore to prevent cloud snapshot overwrite
        if (typeof syncCustomerToFirestore === 'function') {
          for (const cust of state.customers) {
            await syncCustomerToFirestore(cust);
          }
        }
        if (typeof syncTransactionToFirestore === 'function' && Array.isArray(state.transactions)) {
          for (const txn of state.transactions) {
            await syncTransactionToFirestore(txn);
          }
        }

        initApp();
        alert('Data backup successfully restored and synced to cloud!');
      } else {
        alert('Invalid backup file format.');
      }
    } catch (err) {
      alert('Error parsing backup JSON file.');
    }
  };
  reader.readAsText(file);
}

// ====================================================
// EXCEL & CSV DATA IMPORT ENGINE WITH BALANCE RECONCILIATION
// ====================================================
let parsedExcelCustomers = [];

function openExcelImportModal() {
  parsedExcelCustomers = [];
  const fileInput = document.getElementById('excel-file-input');
  if (fileInput) fileInput.value = '';
  const filenameEl = document.getElementById('excel-selected-filename');
  if (filenameEl) {
    filenameEl.style.display = 'none';
    filenameEl.textContent = '';
  }
  const previewContainer = document.getElementById('excel-preview-container');
  if (previewContainer) previewContainer.style.display = 'none';
  const errorEl = document.getElementById('excel-import-error');
  if (errorEl) errorEl.style.display = 'none';
  const confirmBtn = document.getElementById('btn-confirm-excel-import');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = 'Confirm & Import Customers ↵';
  }
  openModal('modal-excel-import');
}

function downloadExcelImportTemplate() {
  const headers = [
    'Customer Number',
    'Loan Number',
    'Full Name',
    'Mobile Phone',
    'Area / Route',
    'Address',
    'Loan Given Amount',
    'Total Instalments',
    'Instalment Amount',
    'Frequency',
    'Loan Start Date',
    'Paid Instalments Count',
    'Total Paid Amount',
    'Remaining Balance',
    'Instructions'
  ];

  const sampleRows = [
    [
      1,
      1,
      'Ramesh Kumar',
      '9876543210',
      'Market Line',
      'Shop #12, Market Road',
      10000,
      52,
      200,
      'Weekly',
      '2025-08-01',
      52,
      10400,
      0,
      'Example 1A: Customer #1, Loan 1 (Completed previous loan with 0 balance)'
    ],
    [
      1,
      2,
      'Ramesh Kumar',
      '9876543210',
      'Market Line',
      'Shop #12, Market Road',
      20000,
      52,
      520,
      'Weekly',
      '2026-08-01',
      15,
      7800,
      19240,
      'Example 1B: Customer #1, Loan 2 (Second active loan for same customer)'
    ],
    [
      2,
      1,
      'Priya Sharma',
      '9845123456',
      'Gandhi Nagar',
      'H.No 4-51, 2nd Cross',
      10000,
      100,
      100,
      'Daily',
      '2026-09-01',
      25,
      2500,
      7500,
      'Example 2: Customer #2, Daily 100-day loan with remaining balance of 7500'
    ],
    [
      3,
      1,
      'Suresh Reddy',
      '9988776655',
      'Station Area',
      'Near Platform 1',
      10000,
      52,
      200,
      'Weekly',
      '2026-10-15',
      0,
      0,
      10400,
      'Example 3: Customer #3, Fresh loan with 0 paid and full 10400 balance'
    ]
  ];

  if (typeof XLSX !== 'undefined') {
    const ws = XLSX.utils.aoa_to_sheet([headers, ...sampleRows]);
    ws['!cols'] = [
      { wch: 16 }, { wch: 12 }, { wch: 18 }, { wch: 14 }, { wch: 16 }, { wch: 24 },
      { wch: 18 }, { wch: 16 }, { wch: 16 }, { wch: 12 }, { wch: 15 },
      { wch: 22 }, { wch: 18 }, { wch: 18 }, { wch: 55 }
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Loan Ledger');
    XLSX.writeFile(wb, 'JSR_Finance_Import_Template.xlsx');
  } else {
    // Pure CSV fallback
    const csvContent = [headers.join(','), ...sampleRows.map(r => r.map(c => `"${c}"`).join(','))].join('\n');
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.download = 'JSR_Finance_Import_Template.csv';
    link.click();
  }
}

function handleExcelFileSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (!file) return;

  const filenameEl = document.getElementById('excel-selected-filename');
  if (filenameEl) {
    filenameEl.textContent = `📄 Selected: ${file.name} (${Math.round(file.size / 1024)} KB)`;
    filenameEl.style.display = 'block';
  }

  const errorEl = document.getElementById('excel-import-error');
  if (errorEl) errorEl.style.display = 'none';

  const reader = new FileReader();

  if (file.name.endsWith('.csv')) {
    reader.onload = function(e) {
      try {
        const text = e.target.result;
        processRawImportData(parseCSVTextToRows(text));
      } catch (err) {
        showExcelImportError('Failed to parse CSV file: ' + err.message);
      }
    };
    reader.readAsText(file);
  } else {
    reader.onload = function(e) {
      try {
        if (typeof XLSX === 'undefined') {
          showExcelImportError('Excel parser library is loading. Please try again in a moment or use CSV.');
          return;
        }
        const data = new Uint8Array(e.target.result);
        const workbook = XLSX.read(data, { type: 'array' });
        const firstSheetName = workbook.SheetNames[0];
        const worksheet = workbook.Sheets[firstSheetName];
        const rawJson = XLSX.utils.sheet_to_json(worksheet, { header: 1, defval: '' });
        processRawImportData(rawJson);
      } catch (err) {
        showExcelImportError('Failed to parse Excel file: ' + err.message);
      }
    };
    reader.readAsArrayBuffer(file);
  }
}

function parseCSVTextToRows(csvText) {
  const rows = [];
  const lines = csvText.split(/\r?\n/);
  for (let line of lines) {
    line = line.trim();
    if (!line) continue;
    const row = [];
    let insideQuotes = false;
    let entry = '';
    for (let i = 0; i < line.length; i++) {
      const c = line[i];
      if (c === '"') {
        insideQuotes = !insideQuotes;
      } else if (c === ',' && !insideQuotes) {
        row.push(entry.trim());
        entry = '';
      } else {
        entry += c;
      }
    }
    row.push(entry.trim());
    rows.push(row);
  }
  return rows;
}

function showExcelImportError(msg) {
  const errorEl = document.getElementById('excel-import-error');
  if (errorEl) {
    errorEl.innerHTML = `<strong>⚠️ Import Error:</strong> ${msg}`;
    errorEl.style.display = 'flex';
  }
}

// Robust Excel Date Parser (supports Excel serial numbers, DD/MM/YYYY, DD-MM-YYYY, YYYY-MM-DD, 2-digit years, Date objects)
function parseExcelDate(val) {
  if (val === null || val === undefined || val === '') return null;
  if (val instanceof Date) {
    if (!isNaN(val.getTime())) {
      return getISTDateString(val);
    }
    return null;
  }
  if (typeof val === 'number' || (!isNaN(val) && Number(val) > 20000 && !String(val).includes('-') && !String(val).includes('/'))) {
    const serial = Number(val);
    const utcDays = Math.floor(serial - 25569);
    const utcValue = utcDays * 86400;
    const dateInfo = new Date(utcValue * 1000);
    return sanitizeDateYear(dateInfo.toISOString().split('T')[0]);
  }
  const str = String(val).trim();
  const dmy = str.match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/);
  if (dmy) {
    const d = dmy[1].padStart(2, '0');
    const m = dmy[2].padStart(2, '0');
    let y = dmy[3];
    if (y.length === 2) y = '20' + y;
    return sanitizeDateYear(`${y}-${m}-${d}`);
  }
  const ymd = str.match(/^(\d{2,6})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
  if (ymd) {
    let y = ymd[1];
    const m = ymd[2].padStart(2, '0');
    const d = ymd[3].padStart(2, '0');
    if (y.length === 2) y = '20' + y;
    return sanitizeDateYear(`${y}-${m}-${d}`);
  }
  const dt = new Date(str);
  if (!isNaN(dt.getTime())) {
    return sanitizeDateYear(dt.toISOString().split('T')[0]);
  }
  return null;
}

function processRawImportData(rows) {
  if (!rows || rows.length < 2) {
    showExcelImportError('The selected file does not contain enough data rows.');
    return;
  }

  // Find header row and map columns
  const rawHeaders = rows[0].map(h => String(h || '').trim().toLowerCase().replace(/[\s\-_#\/]/g, ''));

  const findCol = (synonyms) => {
    // Priority 1: Exact cleaned header match
    for (let syn of synonyms) {
      const cleanSyn = syn.toLowerCase().replace(/[\s\-_#\/]/g, '');
      const idx = rawHeaders.findIndex(h => h === cleanSyn);
      if (idx !== -1) return idx;
    }
    // Priority 2: Substring inclusion match
    for (let syn of synonyms) {
      const cleanSyn = syn.toLowerCase().replace(/[\s\-_#\/]/g, '');
      const idx = rawHeaders.findIndex(h => h.includes(cleanSyn));
      if (idx !== -1) return idx;
    }
    return -1;
  };

  const colCustNum = findCol(['customernumber', 'custnumber', 'custno', 'customerid', 'accountno', 'id', 'no']);
  const colLoanNum = findCol(['loannumber', 'loanno', 'loan#', 'loancount', 'cycle', 'loancycle', 'loanid', 'loanindex', 'loan']);
  const colName = findCol(['fullname', 'customername', 'name', 'clientname', 'customer']);
  const colPhone = findCol(['mobilephone', 'mobile', 'phone', 'contact', 'phonenumber']);
  const colArea = findCol(['arearoute', 'area', 'route', 'location', 'line']);
  const colAddress = findCol(['address', 'fulladdress', 'landmark', 'street']);
  const colGiven = findCol(['loangivenamount', 'givenamount', 'principal', 'loanamount', 'disbursed', 'given']);
  const colInstCount = findCol(['totalinstalments', 'instalments', 'weeks', 'days', 'duration', 'tenure']);
  const colInstAmt = findCol(['instalmentamount', 'emi', 'weeklyamount', 'dailyamount', 'amount', 'rate']);
  const colFreq = findCol(['frequency', 'type', 'scheme', 'freq']);
  const colDate = findCol(['loanstartdate', 'startdate', 'disbursaldate', 'loandate', 'date']);
  const colPaidCount = findCol(['paidinstalmentscount', 'paidinstalments', 'paidcount', 'paidweeks', 'paiddays']);
  const colTotalPaid = findCol(['totalpaidamount', 'totalpaid', 'paidamount', 'collected', 'recovered', 'amountpaid']);
  const colBalance = findCol(['remainingbalance', 'balanceamount', 'balance', 'pendingbalance', 'duebalance', 'bal']);

  if (colName === -1 && colCustNum === -1) {
    showExcelImportError('Could not find Customer Name or Number columns in your sheet. Please use our template.');
    return;
  }

  const parsedCustomers = [];
  const todayStr = getISTDateString();
  const seenCustomerLoans = {};

  for (let r = 1; r < rows.length; r++) {
    const row = rows[r];
    if (!row || row.length === 0 || row.every(cell => !cell)) continue;

    const fullName = String(row[colName !== -1 ? colName : 1] || '').trim();
    if (!fullName) continue;

    const rawCustCell = String(row[colCustNum !== -1 ? colCustNum : 0] || '').trim();
    let customerNumber = null;
    let loanNumber = null;

    // Check for inline Customer & Loan format (e.g. "1-2", "1/2", "1 L2", "#1-L2")
    const inlineMatch = rawCustCell.match(/^#?(\d+)[\s\-_/]+[lL]?(\d+)$/i);
    if (inlineMatch) {
      customerNumber = parseInt(inlineMatch[1], 10);
      loanNumber = parseInt(inlineMatch[2], 10);
    } else {
      const pureDigits = rawCustCell.replace(/[^0-9]/g, '');
      customerNumber = pureDigits ? parseInt(pureDigits, 10) : r;
    }

    // Explicit Loan Number column overrides or populates loanNumber if provided
    if (colLoanNum !== -1 && row[colLoanNum] !== undefined && String(row[colLoanNum]).trim() !== '') {
      const parsedLoan = parseInt(String(row[colLoanNum]).replace(/[^0-9]/g, ''), 10);
      if (!isNaN(parsedLoan) && parsedLoan > 0) {
        loanNumber = parsedLoan;
      }
    }

    // If loanNumber was not explicitly provided:
    // Auto-increment if customer number repeated within the import file
    if (!loanNumber) {
      if (seenCustomerLoans[customerNumber]) {
        loanNumber = seenCustomerLoans[customerNumber] + 1;
      } else {
        loanNumber = 1;
      }
    }
    seenCustomerLoans[customerNumber] = Math.max(loanNumber, seenCustomerLoans[customerNumber] || 0);

    const phone = colPhone !== -1 ? String(row[colPhone] || '').trim() : '';
    const areaRoute = colArea !== -1 ? String(row[colArea] || 'General').trim() : 'General';
    const address = colAddress !== -1 ? String(row[colAddress] || '').trim() : '';
    const givenAmount = Math.max(100, Number(row[colGiven !== -1 ? colGiven : -1]) || 10000);
    const totalInstalments = Math.max(1, parseInt(row[colInstCount !== -1 ? colInstCount : -1], 10) || 52);
    const instalmentAmount = Math.max(1, Number(row[colInstAmt !== -1 ? colInstAmt : -1]) || Math.round((givenAmount * 1.04) / totalInstalments));
    const totalPayable = totalInstalments * instalmentAmount;

    let frequency = colFreq !== -1 ? String(row[colFreq] || '').trim() : '';
    if (!frequency) {
      frequency = totalInstalments === 100 ? 'Daily' : 'Weekly';
    }

    let rawDateVal = colDate !== -1 ? row[colDate] : null;
    let parsedStartDate = parseExcelDate(rawDateVal);

    // Exact balance reconciliation logic
    const rawBalance = colBalance !== -1 && row[colBalance] !== '' ? Number(row[colBalance]) : null;
    const rawTotalPaid = colTotalPaid !== -1 && row[colTotalPaid] !== '' ? Number(row[colTotalPaid]) : null;
    const rawPaidCount = colPaidCount !== -1 && row[colPaidCount] !== '' ? Number(row[colPaidCount]) : null;

    let targetPaid = 0;
    if (rawBalance !== null && !isNaN(rawBalance)) {
      targetPaid = Math.max(0, Math.min(totalPayable, totalPayable - rawBalance));
    } else if (rawTotalPaid !== null && !isNaN(rawTotalPaid)) {
      targetPaid = Math.max(0, Math.min(totalPayable, rawTotalPaid));
    } else if (rawPaidCount !== null && !isNaN(rawPaidCount)) {
      targetPaid = Math.max(0, Math.min(totalPayable, rawPaidCount * instalmentAmount));
    }

    // Build schedule
    const instalments = [];
    let accumulatedPaid = 0;
    const paidCountEstimated = instalmentAmount > 0 ? Math.floor(targetPaid / instalmentAmount) : 0;
    const todayMs = new Date(todayStr).getTime();
    const intervalDays = frequency === 'Daily' ? 1 : 7;
    const intervalMs = intervalDays * 86400000;

    let startMs;
    if (parsedStartDate) {
      startMs = new Date(parsedStartDate).getTime();
      // If start date was set to today or future, but customer already has paid instalments,
      // adjust start date into the past so that already-received instalments do not appear in the future!
      if (startMs >= todayMs && paidCountEstimated > 1) {
        startMs = todayMs - ((paidCountEstimated - 1) * intervalMs);
      }
    } else {
      // No explicit date provided in Excel: anchor most recent paid instalment to today/past
      if (paidCountEstimated > 0) {
        startMs = todayMs - ((paidCountEstimated - 1) * intervalMs);
      } else {
        startMs = todayMs;
      }
    }
    const finalStartDate = sanitizeDateYear(new Date(startMs).toISOString().split('T')[0]);

    for (let i = 1; i <= totalInstalments; i++) {
      const daysOffset = (i - 1) * intervalDays;
      const instDate = sanitizeDateYear(new Date(startMs + daysOffset * 86400000).toISOString().split('T')[0]);
      const remainingToAllocate = targetPaid - accumulatedPaid;

      if (remainingToAllocate >= instalmentAmount) {
        instalments.push({
          number: i,
          dueAmount: instalmentAmount,
          paidAmount: instalmentAmount,
          status: 'Received',
          paidDate: instDate,
          paidTimestamp: `${instDate} 10:00 AM`,
          receiptNumber: `IMP-REC-${customerNumber}-L${loanNumber}-${i}`
        });
        accumulatedPaid += instalmentAmount;
      } else if (remainingToAllocate > 0) {
        instalments.push({
          number: i,
          dueAmount: instalmentAmount,
          paidAmount: remainingToAllocate,
          status: 'Partial',
          paidDate: instDate,
          paidTimestamp: `${instDate} 10:00 AM`,
          receiptNumber: `IMP-PART-${customerNumber}-L${loanNumber}-${i}`
        });
        accumulatedPaid += remainingToAllocate;
      } else {
        instalments.push({
          number: i,
          dueAmount: instalmentAmount,
          paidAmount: 0,
          status: 'Pending'
        });
      }
    }

    const newId = `CUST-${customerNumber}-L${loanNumber}-${Date.now()}-${r}`;
    parsedCustomers.push({
      id: newId,
      customerNumber,
      loanNumber,
      fullName,
      phone,
      areaRoute,
      address,
      givenAmount,
      totalInstalments,
      instalmentAmount,
      totalPayable,
      startDate: finalStartDate,
      status: targetPaid >= totalPayable ? 'Completed' : 'Active',
      frequency,
      instalments,
      createdAt: new Date().toISOString()
    });
  }

  if (parsedCustomers.length === 0) {
    showExcelImportError('No valid customer records could be read from this file.');
    return;
  }

  parsedExcelCustomers = parsedCustomers;
  renderExcelImportPreview(parsedCustomers);
}

function renderExcelImportPreview(customers) {
  let totalDisbursed = 0;
  let totalCollected = 0;
  let totalBalance = 0;

  customers.forEach(c => {
    totalDisbursed += (c.givenAmount || 0);
    const s = getCustomerStats(c);
    totalCollected += s.totalPaid;
    totalBalance += s.balance;
  });

  const countEl = document.getElementById('excel-preview-count');
  const disbEl = document.getElementById('excel-preview-disbursed');
  const collEl = document.getElementById('excel-preview-collected');
  const balEl = document.getElementById('excel-preview-balance');

  if (countEl) countEl.textContent = customers.length;
  if (disbEl) disbEl.textContent = formatMoney(totalDisbursed);
  if (collEl) collEl.textContent = formatMoney(totalCollected);
  if (balEl) balEl.textContent = formatMoney(totalBalance);

  const tbody = document.getElementById('excel-preview-table-body');
  if (tbody) {
    const previewRows = customers.slice(0, 5);
    tbody.innerHTML = previewRows.map(c => {
      const s = getCustomerStats(c);
      return `
        <tr>
          <td>
            <strong>#${c.customerNumber}</strong>
            <span class="cust-loan-badge" style="font-size:11px; padding:2px 6px; margin-left:4px; font-weight:700; background:#e0f2fe; color:#0369a1; border-radius:4px;">L${c.loanNumber || 1}</span>
          </td>
          <td><strong>${c.fullName}</strong></td>
          <td>${c.phone || '-'}</td>
          <td>${c.areaRoute}</td>
          <td>${formatMoney(c.givenAmount)}</td>
          <td>${formatMoney(c.instalmentAmount)}</td>
          <td><span class="badge-received" style="padding:2px 8px; width:auto;">${s.paidCount} / ${c.totalInstalments}</span></td>
          <td style="color:#16a34a; font-weight:700;">${formatMoney(s.totalPaid)}</td>
          <td style="color:#b45309; font-weight:700;">${formatMoney(s.balance)}</td>
        </tr>
      `;
    }).join('');
  }

  const container = document.getElementById('excel-preview-container');
  if (container) container.style.display = 'block';

  const confirmBtn = document.getElementById('btn-confirm-excel-import');
  if (confirmBtn) {
    confirmBtn.disabled = false;
    confirmBtn.textContent = `Confirm & Import ${customers.length} Customers ↵`;
  }
}

async function executeExcelImport() {
  if (!parsedExcelCustomers || parsedExcelCustomers.length === 0) return;

  const modeRadio = document.querySelector('input[name="excel-import-mode"]:checked');
  const mode = modeRadio ? modeRadio.value : 'merge';

  const confirmBtn = document.getElementById('btn-confirm-excel-import');
  if (confirmBtn) {
    confirmBtn.disabled = true;
    confirmBtn.textContent = '⏳ Importing & Syncing to Cloud...';
  }

  if (mode === 'replace') {
    state.customers = [];
    state.transactions = [];
  }

  parsedExcelCustomers.forEach(imported => {
    const existingIdx = state.customers.findIndex(c => 
      c.customerNumber.toString() === imported.customerNumber.toString() && (c.loanNumber || 1) === (imported.loanNumber || 1)
    );
    if (existingIdx !== -1) {
      state.customers[existingIdx] = imported;
    } else {
      state.customers.push(imported);
    }
  });

  // Sort customers numerically by customer number, then by loan number
  state.customers.sort((a, b) => {
    const diff = Number(a.customerNumber) - Number(b.customerNumber);
    if (diff !== 0) return diff;
    return (Number(a.loanNumber) || 1) - (Number(b.loanNumber) || 1);
  });

  // Update next customer number
  let maxNum = 0;
  state.customers.forEach(c => {
    const n = Number(c.customerNumber) || 0;
    if (n > maxNum) maxNum = n;
  });
  state.settings.nextCustNumber = maxNum + 1;

  saveData();

  // Cloud Firestore Batch / Concurrent Sync
  if (typeof syncCustomerToFirestore === 'function') {
    for (const c of parsedExcelCustomers) {
      syncCustomerToFirestore(c);
    }
  }

  updateHeaderStats();
  renderCollectionMatrix();
  renderCustomersTable();
  if (state.activeTab === 'summary') renderDashboard();
  if (state.activeTab === 'analytics') renderAnalytics();

  playCashChime();
  showToast(`✓ Successfully imported ${parsedExcelCustomers.length} customers from Excel with exact balances!`);
  closeModal('modal-excel-import');
}

// Export Collection Sheet as CSV
function exportCollectionSheetCSV() {
  let maxInst = 52;
  state.customers.forEach((c) => {
    const instCount = c.totalInstalments || 52;
    if (instCount > maxInst) maxInst = instCount;
  });

  let csv = 'Cust Number,Customer Name,Phone,Plan,Given Amount,Instalment Amount,Paid Count,Balance';
  for (let i = 1; i <= maxInst; i++) csv += `,Instalment ${i}`;
  csv += '\n';

  state.customers.forEach((c) => {
    const s = getCustomerStats(c);
    const plan = c.frequency === 'Daily' || (c.totalInstalments === 100) ? 'Daily' : 'Weekly';
    let row = `"${c.customerNumber}","${c.fullName}","${c.phone || ''}","${plan}",${c.givenAmount},${c.instalmentAmount},${s.paidCount},${s.balance}`;
    const totalInst = c.totalInstalments || 52;
    for (let i = 1; i <= maxInst; i++) {
      if (i > totalInst) {
        row += `,"-"`;
      } else {
        const inst = (c.instalments && c.instalments[i - 1]) || {};
        const cellStatus = inst.status === 'Received' ? 'Received' : (inst.status === 'Partial' ? `Partial (₹${inst.paidAmount})` : 'Pending');
        row += `,"${cellStatus}"`;
      }
    }
    csv += row + '\n';
  });

  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `JSR_Instalment_Sheet_${getISTDateString()}.csv`;
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
  const currentUser = getCurrentUser();
  if (currentUser.role === 'Collector') {
    alert('Access Denied: Only Owner / Admin can reset or clear system data.');
    return;
  }
  const confirmPrompt = prompt('CRITICAL WARNING: This will permanently wipe all customer records and transactions!\n\nTo confirm, type RESET in all capital letters:');
  if (confirmPrompt === 'RESET') {
    state.customers = [];
    state.transactions = [];
    state.settings.nextCustNumber = 1;
    saveData();
    initApp();
    showToast('All customer data cleared.');
  } else if (confirmPrompt !== null) {
    alert('Reset cancelled. Confirmation text did not match.');
  }
}

// UI Helpers: Modals & Toasts
function openModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.add('active');
    document.body.classList.add('modal-open');
    const body = modal.querySelector('.modal-body');
    if (body) body.scrollTop = 0;
  }
}

function closeModal(modalId) {
  const modal = document.getElementById(modalId);
  if (modal) {
    modal.classList.remove('active');
    modal.style.display = 'none';
  }
  const hasActiveModal = document.querySelector('.modal-overlay.active') || 
    Array.from(document.querySelectorAll('.modal-overlay')).some(m => m.style.display === 'flex' || m.style.display === 'block');
  const hasTooltip = document.getElementById('loans-tooltip-popover')?.dataset?.openCust;
  if (!hasActiveModal && !hasTooltip) {
    document.body.classList.remove('modal-open');
  }
}

function showToast(message, duration = 3000) {
  const toast = document.getElementById('app-toast');
  if (toast) {
    toast.textContent = message;
    toast.style.display = 'block';
    if (toast._timer) clearTimeout(toast._timer);
    toast._timer = setTimeout(() => {
      toast.style.display = 'none';
    }, duration);
  }

  // Also mirror message directly into Customer Detail Modal if currently open
  const detailModal = document.getElementById('modal-customer-detail');
  const alertBox = document.getElementById('cust-detail-alert-box');
  if (detailModal && detailModal.style.display !== 'none' && alertBox) {
    alertBox.textContent = message;
    alertBox.style.display = 'block';
    if (message.includes('⚠️') || message.includes('🔒')) {
      alertBox.style.background = '#fffbeb';
      alertBox.style.color = '#92400e';
      alertBox.style.border = '1.5px solid #fde68a';
    } else if (message.includes('✓') || message.includes('✅') || message.includes('↩️')) {
      alertBox.style.background = '#f0fdf4';
      alertBox.style.color = '#166534';
      alertBox.style.border = '1.5px solid #bbf7d0';
    } else {
      alertBox.style.background = '#f8fafc';
      alertBox.style.color = '#1e293b';
      alertBox.style.border = '1.5px solid #cbd5e1';
    }
    if (alertBox._timer) clearTimeout(alertBox._timer);
    alertBox._timer = setTimeout(() => {
      alertBox.style.display = 'none';
    }, duration);
  }
}

// ----------------------------------------------------
// SCREEN: FIELD COLLECTION RUN SHEET
// ----------------------------------------------------
function renderRunSheet() {
  const container = document.getElementById('runsheet-cards-container');
  if (!container) return;

  const routeFilterSelect = document.getElementById('runsheet-route-filter');
  const searchInput = document.getElementById('runsheet-search-input');
  const selectedRoute = routeFilterSelect ? routeFilterSelect.value : 'all';
  const query = searchInput ? searchInput.value.toLowerCase().trim() : '';
  const todayStr = getISTDateString();

  // Populate route filter options
  if (routeFilterSelect) {
    const currentVal = routeFilterSelect.value;
    const routes = new Set();
    state.customers.forEach((c) => {
      if (c.areaRoute) routes.add(c.areaRoute.trim());
    });
    let optionsHtml = '<option value="all">All Routes / Areas</option>';
    Array.from(routes).sort().forEach((r) => {
      optionsHtml += `<option value="${r}">${r}</option>`;
    });
    routeFilterSelect.innerHTML = optionsHtml;
    if (Array.from(routes).includes(currentVal) || currentVal === 'all') {
      routeFilterSelect.value = currentVal;
    }
  }

  // Filter active customers for today's run
  const activeCustomers = state.customers.filter((c) => {
    const stats = getCustomerStats(c);
    if (stats.isCompleted) return false;

    if (selectedRoute !== 'all' && (c.areaRoute || 'General') !== selectedRoute) {
      return false;
    }

    if (query) {
      const matchNum = c.customerNumber.toString().includes(query);
      const matchName = c.fullName.toLowerCase().includes(query);
      const matchPhone = (c.phone || '').includes(query);
      const matchArea = (c.areaRoute || '').toLowerCase().includes(query);
      if (!matchNum && !matchName && !matchPhone && !matchArea) return false;
    }

    return true;
  });

  // Calculate run sheet metrics
  let totalActive = activeCustomers.length;
  let collectedTodayCount = 0;
  let collectedTodayRupees = 0;

  activeCustomers.forEach((c) => {
    const todayInsts = (c.instalments || []).filter(
      (inst) => inst && (inst.status === 'Received' || inst.status === 'Partial') && inst.paidDate === todayStr
    );
    if (todayInsts.length > 0) {
      collectedTodayCount++;
      todayInsts.forEach((inst) => {
        if (inst.status === 'Partial') {
          collectedTodayRupees += (Number(inst.paidAmount) || 0);
        } else {
          collectedTodayRupees += (Number(inst.paidAmount) || c.instalmentAmount || 0);
        }
      });
    }
  });

  // Update Progress Strip
  const progressText = document.getElementById('runsheet-progress-text');
  const progressFill = document.getElementById('runsheet-progress-fill');
  const rupeesText = document.getElementById('runsheet-collected-rupees');

  const pct = totalActive > 0 ? Math.round((collectedTodayCount / totalActive) * 100) : 0;
  if (progressText) progressText.textContent = `${collectedTodayCount} / ${totalActive} Collected (${pct}%)`;
  if (progressFill) progressFill.style.width = `${pct}%`;
  if (rupeesText) rupeesText.textContent = `${formatMoney(collectedTodayRupees)} Collected Today`;

  if (activeCustomers.length === 0) {
    container.innerHTML = `<div style="grid-column: 1 / -1; text-align: center; padding: 40px; color: #94a3b8; background: #fff; border-radius: 12px; border: 1px solid #e2e8f0;">No active customers found for this route.</div>`;
    return;
  }

  // Render Run Sheet Cards
  container.innerHTML = activeCustomers.map((c) => {
    const stats = getCustomerStats(c);
    const totalInst = c.totalInstalments || 52;
    const isDaily = c.frequency === 'Daily' || totalInst === 100;
    const unitLabel = isDaily ? 'Day' : 'Week';

    // Check if paid today
    const paidTodayInst = (c.instalments || []).find(
      (inst) => inst && (inst.status === 'Received' || inst.status === 'Partial') && inst.paidDate === todayStr
    );
    const isPaidToday = !!paidTodayInst;

    // Find next pending or partial instalment
    let nextDueNum = 1;
    let nextDueAmount = c.instalmentAmount;
    let isNextPartial = false;
    for (let i = 1; i <= totalInst; i++) {
      const inst = (c.instalments && c.instalments[i - 1]);
      if (!inst || inst.status !== 'Received') {
        nextDueNum = i;
        if (inst && inst.status === 'Partial') {
          isNextPartial = true;
          nextDueAmount = Math.max(0, c.instalmentAmount - (Number(inst.paidAmount) || 0));
        } else {
          nextDueAmount = c.instalmentAmount;
        }
        break;
      }
    }

    const loanBadgeHtml = (c.loanNumber && c.loanNumber > 1) ? ` <span class="loan-badge">L${c.loanNumber}</span>` : '';
    const cleanPhone = c.phone ? c.phone.replace(/[^0-9]/g, '') : '';

    return `
      <div class="runsheet-card ${isPaidToday ? 'is-paid-today' : ''}">
        <div class="runsheet-header">
          <div>
            <div style="font-weight: 700; font-size: 15px; color: #1e293b; display: flex; align-items: center; gap: 6px;">
              <span style="color: #1e40af;">#${c.customerNumber}</span>${loanBadgeHtml} - ${c.fullName}
            </div>
            <div style="font-size: 12px; color: #64748b; margin-top: 2px;">
              📍 ${c.address || 'No Address'} • <span style="background: #e0f2fe; color: #0369a1; padding: 1px 6px; border-radius: 4px; font-weight: 600;">${c.areaRoute || 'General'}</span>
            </div>
          </div>
          <div>
            ${isPaidToday
              ? `<span class="badge-status badge-status-success">✓ Paid Today</span>`
              : (stats.isOverdue
                  ? `<span class="badge-status badge-status-overdue" title="Delayed Schedule: Borrower is ${stats.missedCount} instalments behind schedule (Overdue: ${formatMoney(stats.missedCount * (c.instalmentAmount || 0))})">⚠️ ${stats.missedCount} Overdue (Delayed)</span>`
                  : `<span style="font-size: 12px; font-weight: 700; color: #2563eb;">${unitLabel} #${nextDueNum}</span>`)}
          </div>
        </div>

        <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin: 10px 0; background: #f8fafc; padding: 10px; border-radius: 8px; font-size: 12px;">
          <div>
            <span style="color: #64748b;">Due Now:</span><br>
            <strong style="color: #1e3a8a; font-size: 14px;">${formatMoney(nextDueAmount)}</strong>
          </div>
          <div>
            <span style="color: #64748b;">Paid:</span><br>
            <strong style="color: #16a34a;">${stats.paidCount}/${totalInst}</strong>
          </div>
          <div>
            <span style="color: #64748b;">Balance:</span><br>
            <strong style="color: #b45309;">${formatMoney(stats.balance)}</strong>
          </div>
        </div>

        <div class="runsheet-actions">
          ${isPaidToday
            ? `<button class="btn btn-sm btn-outline" style="background: #ecfdf5; color: #15803d; border-color: #86efac; flex: 1;" onclick="sendWhatsAppPaymentReceipt('${c.id}', ${paidTodayInst.paidAmount || (paidTodayInst.status === 'Partial' ? 0 : c.instalmentAmount)}, ${paidTodayInst.number})">
                🧾 Send Receipt
               </button>`
            : `<button class="btn btn-sm btn-success" style="flex: 1;" onclick="toggleInstalmentReceived('${c.id}', ${nextDueNum}); renderRunSheet();">
                ⚡ Collect ${formatMoney(nextDueAmount)}
               </button>
               <button class="btn btn-sm btn-outline" style="color: #d97706; border-color: #fde68a;" onclick="openPartialPayModal('${c.id}', ${nextDueNum})">
                ½ Custom ₹
               </button>`
          }

          ${cleanPhone
            ? `<a href="tel:${cleanPhone}" class="btn btn-sm btn-outline" style="text-decoration: none;" title="Call Customer">
                📞 Call
               </a>
               <button class="btn btn-sm btn-outline" style="color: #16a34a; border-color: #86efac;" onclick="sendWhatsAppDueReminder('${c.id}')" title="Send WhatsApp Reminder">
                💬 WA
               </button>`
            : ''
          }
          <button class="btn btn-sm btn-outline" onclick="openCustomerPassbook('${c.id}')" title="View Full Passbook">
            📖
          </button>
        </div>
      </div>
    `;
  }).join('');
}

// ----------------------------------------------------
// WHATSAPP INTEGRATION (DUE REMINDER & INSTANT RECEIPT)
// ----------------------------------------------------
function formatWhatsAppPhone(rawPhone) {
  if (!rawPhone) return '';
  const digits = rawPhone.toString().replace(/\D/g, '');
  if (digits.length === 10) return '91' + digits;
  if (digits.length === 12 && digits.startsWith('91')) return digits;
  return digits;
}

function sendWhatsAppDueReminder(customerId) {
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  const phone = formatWhatsAppPhone(c.phone);
  if (!phone) {
    alert(`No valid phone number found for ${c.fullName}.`);
    return;
  }

  const stats = getCustomerStats(c);
  const totalInst = c.totalInstalments || 52;
  const isDaily = c.frequency === 'Daily' || totalInst === 100;
  const freqLabel = isDaily ? 'daily' : 'weekly';

  const loanSuffix = (c.loanNumber && c.loanNumber > 1) ? ` (Loan #${c.loanNumber})` : '';
  const message = 
`*${state.settings.businessName || 'JSR Finance'} - Instalment Due Reminder*

Dear *${c.fullName}* (Cust #${c.customerNumber}${loanSuffix}),

This is a friendly reminder for your *${freqLabel} instalment*:
• Due Amount: *${formatMoney(c.instalmentAmount)}*
• Remaining Balance: *${formatMoney(stats.balance)}*
• Progress: *${stats.paidCount}/${totalInst} instalments paid*

Kindly keep the amount ready for collection. Thank you!
— *${state.settings.businessName || 'JSR Finance'}*`;

  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank');
}

function sendWhatsAppPaymentReceipt(customerId, paidAmount, instNumber) {
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  const phone = formatWhatsAppPhone(c.phone);
  if (!phone) {
    alert(`No valid phone number found for ${c.fullName}.`);
    return;
  }

  const stats = getCustomerStats(c);
  const totalInst = c.totalInstalments || 52;
  const amountVal = Number(paidAmount) || c.instalmentAmount;
  const todayStr = new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
  const loanSuffix = (c.loanNumber && c.loanNumber > 1) ? ` (Loan #${c.loanNumber})` : '';

  const inst = (c.instalments || []).find((it) => it && it.number === instNumber);
  const rcptNum = (inst && inst.receiptNumber) ? inst.receiptNumber : generateUniqueReceiptNumber(c.customerNumber, c.loanNumber || 1, instNumber || 1);

  const message =
`*PAYMENT RECEIPT - ${state.settings.businessName || 'JSR Finance'}*
━━━━━━━━━━━━━━━━━━━━
✓ *Payment Received: ${formatMoney(amountVal)}*
• Customer: *${c.fullName}* (#${c.customerNumber}${loanSuffix})
• Instalment: *#${instNumber || 1} of ${totalInst}*
• Date: *${todayStr}*
• Receipt #: *${rcptNum}*
• Remaining Balance: *${formatMoney(stats.balance)}*
━━━━━━━━━━━━━━━━━━━━
Thank you for your prompt payment!`;

  const url = `https://wa.me/${phone}?text=${encodeURIComponent(message)}`;
  window.open(url, '_blank');
}

// ----------------------------------------------------
// MODAL: CUSTOM / PARTIAL PAYMENT HANDLERS
// ----------------------------------------------------
function openPartialPayModal(customerId, instNumber) {
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  const totalInst = c.totalInstalments || 52;
  const isDaily = c.frequency === 'Daily' || totalInst === 100;
  const unitLabel = isDaily ? 'Day' : 'Week';

  document.getElementById('partial-cust-id').value = customerId;
  document.getElementById('partial-inst-num').value = instNumber;
  document.getElementById('partial-modal-cust-name').textContent = `#${c.customerNumber} - ${c.fullName}`;
  
  const badgeEl = document.getElementById('partial-modal-inst-badge');
  if (badgeEl) badgeEl.textContent = `${unitLabel} #${instNumber}`;

  const inst = (c.instalments && c.instalments[instNumber - 1]);
  const scheduled = Number(c.instalmentAmount) || 200;
  const paidSoFar = Number(inst?.paidAmount) || 0;
  const remaining = Math.max(0, scheduled - paidSoFar);

  const schedEl = document.getElementById('partial-modal-scheduled');
  if (schedEl) schedEl.textContent = formatMoney(scheduled);

  const paidEl = document.getElementById('partial-modal-already-paid');
  if (paidEl) paidEl.textContent = formatMoney(paidSoFar);

  const priorDueEl = document.getElementById('partial-modal-prior-due');
  if (priorDueEl) priorDueEl.textContent = formatMoney(remaining);

  const amountInput = document.getElementById('partial-pay-amount');
  amountInput.value = remaining > 0 ? remaining : scheduled;
  amountInput.max = remaining > 0 ? remaining : scheduled;

  // Show undo button if previous payments were received on this instalment
  const undoBtn = document.getElementById('partial-modal-undo-btn');
  if (undoBtn) {
    if (paidSoFar > 0) {
      undoBtn.style.display = 'inline-block';
      undoBtn.textContent = `↩️ Undo Received (${formatMoney(paidSoFar)})`;
    } else {
      undoBtn.style.display = 'none';
    }
  }

  updatePartialPayCalc();
  openModal('modal-partial-pay');
  setTimeout(() => amountInput.focus(), 150);
}

function updatePartialPayCalc() {
  const customerId = document.getElementById('partial-cust-id')?.value;
  const instNumber = parseInt(document.getElementById('partial-inst-num')?.value, 10);
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  const inst = (c.instalments && c.instalments[instNumber - 1]);
  const scheduled = Number(c.instalmentAmount) || 200;
  const paidSoFar = Number(inst?.paidAmount) || 0;
  
  const rawInput = document.getElementById('partial-pay-amount')?.value;
  const amountToPay = Math.max(0, Number(rawInput) || 0);

  const totalPaidAfter = paidSoFar + amountToPay;
  const pendingAfter = Math.max(0, scheduled - totalPaidAfter);

  const todayCollectedEl = document.getElementById('partial-calc-today-collected');
  if (todayCollectedEl) {
    todayCollectedEl.textContent = `+ ${formatMoney(amountToPay)}`;
  }

  const pendingEl = document.getElementById('partial-calc-pending-amount');
  if (pendingEl) {
    pendingEl.textContent = formatMoney(pendingAfter);
  }

  const submitBtn = document.getElementById('partial-modal-submit-btn');
  if (submitBtn) {
    if (amountToPay > 0) {
      submitBtn.textContent = `Save Payment (${formatMoney(amountToPay)})`;
    } else {
      submitBtn.textContent = 'Save Payment';
    }
  }
}

function handlePartialModalUndo() {
  const customerId = document.getElementById('partial-cust-id')?.value;
  const instNumber = parseInt(document.getElementById('partial-inst-num')?.value, 10);
  const c = state.customers.find((cust) => cust.id === customerId);
  if (!c) return;

  const inst = (c.instalments && c.instalments[instNumber - 1]);
  if (!inst) return;
  const paidSoFar = Number(inst.paidAmount) || 0;

  if (confirm(`Are you sure you want to undo the received payment of ${formatMoney(paidSoFar)} for Instalment #${instNumber}?`)) {
    closeModal('modal-partial-pay');

    // Record immutable audit ledger undo transaction
    const prevReceipt = inst.receiptNumber || '';
    recordTransaction({
      receiptNumber: `UNDO-${prevReceipt || 'LEGACY'}-${Date.now()}`,
      previousReceipt: prevReceipt,
      customerId: c.id,
      customerNumber: c.customerNumber,
      loanNumber: c.loanNumber || 1,
      customerName: c.fullName,
      instalmentNumber: instNumber,
      amount: paidSoFar,
      type: 'undo',
      date: getISTDateString(),
      timestamp: getNowTimestamp()
    });

    // Reset instalment
    inst.status = 'Pending';
    inst.paidDate = null;
    inst.paidTimestamp = null;
    inst.paidAmount = 0;
    inst.receiptNumber = null;

    saveData();
    if (typeof syncCustomerToFirestore === 'function') {
      syncCustomerToFirestore(c);
    }
    renderCollectionMatrix();
    if (state.activeTab === 'summary') renderDashboard();
    updateHeaderStats();
    showToast(`↩️ Payment undone for Instalment #${instNumber} for #${c.customerNumber}`);
  }
}

function handlePartialPaySubmit(event) {
  if (event) event.preventDefault();
  const customerId = document.getElementById('partial-cust-id').value;
  const instNumber = parseInt(document.getElementById('partial-inst-num').value, 10);
  const amount = Number(document.getElementById('partial-pay-amount').value);

  if (!amount || amount <= 0) {
    alert('Please enter a valid payment amount.');
    return;
  }

  toggleInstalmentReceived(customerId, instNumber, amount);
  closeModal('modal-partial-pay');
}

// ----------------------------------------------------
// MODAL: CASH TALLY & CURRENCY HANDOVER SLIP
// ----------------------------------------------------
function openCashTallyModal() {
  const stats = getPortfolioStats();
  const ledgerEl = document.getElementById('tally-ledger-today');
  if (ledgerEl) ledgerEl.textContent = formatMoney(stats.todayCollected);

  updateCashTallyCalc();
  openModal('modal-cash-tally');
}

function updateCashTallyCalc() {
  const denoms = [
    { id: '500', val: 500 },
    { id: '200', val: 200 },
    { id: '100', val: 100 },
    { id: '50', val: 50 },
    { id: '20', val: 20 },
    { id: '10', val: 10 },
  ];

  let totalPhysical = 0;
  denoms.forEach((d) => {
    const input = document.getElementById(`tally-${d.id}`);
    const count = Math.max(0, parseInt(input?.value, 10) || 0);
    const subtotal = count * d.val;
    totalPhysical += subtotal;

    const subEl = document.getElementById(`tally-sub-${d.id}`);
    if (subEl) subEl.textContent = formatMoney(subtotal);
  });

  const totalEl = document.getElementById('tally-total-counted');
  if (totalEl) totalEl.textContent = formatMoney(totalPhysical);

  const stats = getPortfolioStats();
  const ledgerToday = stats.todayCollected;
  const diff = totalPhysical - ledgerToday;
  const diffEl = document.getElementById('tally-difference');

  if (diffEl) {
    if (diff === 0) {
      diffEl.innerHTML = `<span style="color: #16a34a; font-weight: 700;">✓ Perfectly Balanced (${formatMoney(0)})</span>`;
    } else if (diff > 0) {
      diffEl.innerHTML = `<span style="color: #2563eb; font-weight: 700;">+ Surplus ${formatMoney(diff)}</span>`;
    } else {
      diffEl.innerHTML = `<span style="color: #dc2626; font-weight: 700;">- Shortage ${formatMoney(Math.abs(diff))}</span>`;
    }
  }
}

function printCashHandoverSlip() {
  const stats = getPortfolioStats();
  const todayStr = new Date().toLocaleDateString('en-IN', { weekday: 'long', day: '2-digit', month: 'short', year: 'numeric' });
  const timeStr = new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });

  const denoms = [500, 200, 100, 50, 20, 10];
  let rowsHtml = '';
  let totalPhysical = 0;

  denoms.forEach((d) => {
    const count = parseInt(document.getElementById(`tally-${d}`)?.value, 10) || 0;
    if (count > 0) {
      const sub = count * d;
      totalPhysical += sub;
      rowsHtml += `
        <tr>
          <td style="padding: 6px; border-bottom: 1px solid #ddd;">₹ ${d}</td>
          <td style="padding: 6px; border-bottom: 1px solid #ddd; text-align: center;">× ${count}</td>
          <td style="padding: 6px; border-bottom: 1px solid #ddd; text-align: right; font-weight: 600;">₹ ${sub.toLocaleString('en-IN')}</td>
        </tr>
      `;
    }
  });

  const diff = totalPhysical - stats.todayCollected;
  const diffLabel = diff === 0 ? 'Balanced (₹ 0)' : (diff > 0 ? `+ ₹ ${diff.toLocaleString('en-IN')} (Surplus)` : `- ₹ ${Math.abs(diff).toLocaleString('en-IN')} (Shortage)`);

  const printWindow = window.open('', '_blank', 'width=650,height=750');
  if (!printWindow) {
    alert('Please allow popups to print the Cash Handover Slip.');
    return;
  }

  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>End-of-Day Cash Handover Slip</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; color: #1e293b; }
        .slip-box { max-width: 480px; margin: 0 auto; border: 2px solid #0f172a; padding: 20px; border-radius: 8px; }
        .slip-title { font-size: 18px; font-weight: 800; text-align: center; margin-bottom: 2px; }
        .slip-sub { font-size: 12px; text-align: center; color: #64748b; margin-bottom: 16px; }
        table { width: 100%; border-collapse: collapse; margin-bottom: 16px; font-size: 13px; }
        .summary-row { display: flex; justify-content: space-between; font-size: 13px; margin-bottom: 6px; }
        .sign-area { display: flex; justify-content: space-between; margin-top: 36px; padding-top: 24px; border-top: 1px dashed #cbd5e1; }
        .sign-box { text-align: center; font-size: 12px; font-weight: 600; width: 45%; border-top: 1px solid #000; padding-top: 6px; }
      </style>
    </head>
    <body>
      <div class="slip-box">
        <div class="slip-title">${state.settings.businessName || 'JSR FINANCE'}</div>
        <div class="slip-sub">DAILY CASH TALLY & HANDOVER SLIP<br>${todayStr} at ${timeStr}</div>

        <table>
          <thead>
            <tr style="background: #f1f5f9;">
              <th style="padding: 6px; text-align: left;">Note</th>
              <th style="padding: 6px; text-align: center;">Count</th>
              <th style="padding: 6px; text-align: right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="3" style="text-align: center; padding: 10px;">No notes counted</td></tr>'}
          </tbody>
        </table>

        <div style="background: #f8fafc; padding: 12px; border-radius: 6px; border: 1px solid #e2e8f0;">
          <div class="summary-row">
            <span>Total Physical Cash Counted:</span>
            <strong style="font-size: 15px;">₹ ${totalPhysical.toLocaleString('en-IN')}</strong>
          </div>
          <div class="summary-row">
            <span>Today's Ledger Total:</span>
            <strong>₹ ${stats.todayCollected.toLocaleString('en-IN')}</strong>
          </div>
          <div class="summary-row" style="border-top: 1px dashed #cbd5e1; padding-top: 6px; margin-top: 6px;">
            <span>Reconciliation Status:</span>
            <strong style="color: ${diff === 0 ? '#16a34a' : (diff > 0 ? '#2563eb' : '#dc2626')};">${diffLabel}</strong>
          </div>
        </div>

        <div class="sign-area">
          <div class="sign-box">Field Collector Signature</div>
          <div class="sign-box">Cashier / Manager Signature</div>
        </div>
      </div>
      <script>
        window.onload = function() { window.print(); }
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

// Event Listeners Setup
function setupEventListeners() {
  // Navigation tabs (Desktop & Mobile)
  document.querySelectorAll('.nav-link[data-tab]').forEach((link) => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      if (link.dataset.tab) {
        switchTab(link.dataset.tab);
      }
    });
  });

  document.querySelectorAll('.mobile-nav-item[data-tab]').forEach((item) => {
    item.addEventListener('click', (e) => {
      e.preventDefault();
      if (item.dataset.tab) {
        switchTab(item.dataset.tab);
      }
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

  // Filter selector (Default to Active Only)
  const filterSelect = document.getElementById('collection-filter-select');
  if (filterSelect) {
    filterSelect.value = state.filterStatus || 'active';
    filterSelect.addEventListener('change', (e) => {
      checkAndPromptUnsaved(null, () => {
        state.filterStatus = e.target.value;
        renderCollectionMatrix();
      });
    });
  }

  // Dynamic profit calculation listeners on customer form inputs
  ['cust-form-given', 'cust-form-instalments', 'cust-form-amount', 'cust-form-margin'].forEach((id) => {
    const inputEl = document.getElementById(id);
    if (inputEl) {
      inputEl.addEventListener('input', updateCustomerModalProfitCalc);
    }
  });

  // Summary Screen Portfolio & Recent Feed Loan Filters
  const summaryLoan = document.getElementById('summary-loan-filter');
  if (summaryLoan) summaryLoan.addEventListener('change', (e) => handleSummaryLoanFilterChange(e.target.value));

  // Recent Received Instalments Feed interactive filters
  const recentType = document.getElementById('recent-type-filter');
  if (recentType) recentType.addEventListener('change', renderRecentTransactions);

  const recentLoan = document.getElementById('recent-loan-filter');
  if (recentLoan) recentLoan.addEventListener('change', renderRecentTransactions);

  const recentDate = document.getElementById('recent-date-filter');
  if (recentDate) recentDate.addEventListener('change', renderRecentTransactions);

  const recentSearch = document.getElementById('recent-search-filter');
  if (recentSearch) recentSearch.addEventListener('input', renderRecentTransactions);

  const recentRoute = document.getElementById('recent-route-filter');
  if (recentRoute) recentRoute.addEventListener('change', renderRecentTransactions);

  const recentCollector = document.getElementById('recent-collector-filter');
  if (recentCollector) recentCollector.addEventListener('change', renderRecentTransactions);

  // Customer Master Search & Filter listeners
  const custSearchInput = document.getElementById('cust-search-input');
  if (custSearchInput) custSearchInput.addEventListener('input', handleCustomerFilterChange);

  const custStatusFilter = document.getElementById('cust-filter-status');
  if (custStatusFilter) custStatusFilter.addEventListener('change', handleCustomerFilterChange);

  const custRouteFilter = document.getElementById('cust-filter-route');
  if (custRouteFilter) custRouteFilter.addEventListener('change', handleCustomerFilterChange);

  const custFreqFilter = document.getElementById('cust-filter-frequency');
  if (custFreqFilter) custFreqFilter.addEventListener('change', handleCustomerFilterChange);

  const custSortFilter = document.getElementById('cust-filter-sort');
  if (custSortFilter) custSortFilter.addEventListener('change', handleCustomerFilterChange);

  // Left Menu Hover-to-Open & Click-to-Close behavior
  const sidebar = document.getElementById('app-sidebar');
  if (sidebar) {
    sidebar.addEventListener('mouseenter', () => {
      sidebar.classList.remove('force-collapsed');
    });
    sidebar.addEventListener('mouseleave', () => {
      sidebar.classList.remove('force-collapsed');
    });
  }
}

// ========================================================
// 1. CUSTOMER PROFILE PHOTO LIGHTBOX
// ========================================================
function openCustomerPhotoLightbox(customerId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;

  const modal = document.getElementById('photo-lightbox-backdrop');
  if (!modal) return;

  const imgEl = document.getElementById('photo-lightbox-img');
  const nameEl = document.getElementById('photo-lightbox-name');
  const loanEl = document.getElementById('photo-lightbox-loan');
  const phoneEl = document.getElementById('photo-lightbox-phone');
  const kycEl = document.getElementById('photo-lightbox-kyc');

  if (nameEl) nameEl.textContent = `${customer.fullName} (#${customer.customerNumber})`;
  if (imgEl) {
    if (customer.photoUrl) {
      imgEl.src = customer.photoUrl;
      imgEl.style.display = 'block';
    } else {
      imgEl.src = `data:image/svg+xml;utf8,<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="%23e2e8f0"/><text x="50%" y="54%" font-size="64" font-weight="bold" fill="%2364748b" text-anchor="middle" dominant-baseline="middle">${(customer.fullName || 'C').slice(0, 2).toUpperCase()}</text></svg>`;
      imgEl.style.display = 'block';
    }
  }

  if (loanEl) loanEl.textContent = `Loan #${customer.loanNumber || 1} • Route: ${customer.areaRoute || 'General'} • Principal: ₹${Number(customer.givenAmount || 0).toLocaleString('en-IN')}`;
  if (phoneEl) phoneEl.textContent = `📞 Phone: ${customer.phone || 'No phone'} • Address: ${customer.address || 'No address'}`;
  if (kycEl) {
    kycEl.innerHTML = customer.kycVerified 
      ? `<span class="badge" style="background:#ecfdf5; color:#047857; border:1px solid #a7f3d0; font-size:11.5px; padding:3px 8px; border-radius:4px; font-weight:700;">✓ KYC Document Verified</span>` 
      : `<span class="badge" style="background:#f8fafc; color:#64748b; border:1px solid #cbd5e1; font-size:11.5px; padding:3px 8px; border-radius:4px;">KYC Pending</span>`;
  }

  modal.style.display = 'flex';
  document.body.classList.add('modal-open');
}

function closeCustomerPhotoLightbox() {
  const modal = document.getElementById('photo-lightbox-backdrop');
  if (modal) modal.style.display = 'none';
  if (!document.querySelector('.cust-detail-modal:not([style*="display: none"]), .modal-overlay.active')) {
    document.body.classList.remove('modal-open');
  }
}

// ========================================================
// 2. CUSTOMER DETAIL MODAL & MOBILE BOTTOM SHEET
// ========================================================
function openCustomerDetailModal(customerId, event) {
  if (event) {
    event.stopPropagation();
    event.preventDefault();
  }
  const customer = state.customers.find(c => c.id === customerId);
  if (!customer) return;

  state.activeDetailCustomerId = customerId;

  const modal = document.getElementById('modal-customer-detail');
  const backdrop = document.getElementById('customer-detail-backdrop');
  if (!modal || !backdrop) return;

  // Clear any previous in-modal alert
  const alertBox = document.getElementById('cust-detail-alert-box');
  if (alertBox) {
    alertBox.style.display = 'none';
    alertBox.textContent = '';
  }

  renderCustomerDetailModalContent(customerId);

  backdrop.style.display = 'block';
  modal.style.display = 'flex';
  document.body.classList.add('modal-open');

  const bodyContainer = document.getElementById('cust-detail-loan-content');
  if (bodyContainer) bodyContainer.scrollTop = 0;
}

function switchCustomerDetailLoan(targetLoanId) {
  const currentId = state.activeDetailCustomerId;
  if (currentId && currentId !== targetLoanId && hasActualPendingChanges(currentId)) {
    const pending = state.pendingModifications[currentId];
    const amountStr = pending && pending.sessionAmount ? formatMoney(pending.sessionAmount) : '';
    const shouldSave = confirm(`You have unsaved collections (${amountStr}) for this loan.\n\nClick OK to SAVE before switching loans.\nClick Cancel to DISCARD and switch.`);
    if (shouldSave) {
      saveCustomerModifications(currentId);
    } else {
      discardCustomerModifications(currentId);
    }
  }

  state.activeDetailCustomerId = targetLoanId;
  renderCustomerDetailModalContent(targetLoanId);

  const bodyContainer = document.getElementById('cust-detail-loan-content');
  if (bodyContainer) bodyContainer.scrollTop = 0;
}

function renderCustomerDetailModalContent(loanId) {
  const cust = state.customers.find(c => c.id === loanId);
  if (!cust) return;

  // Header info
  const nameEl = document.getElementById('cust-detail-name');
  const numBadge = document.getElementById('cust-detail-num-badge');
  const subEl = document.getElementById('cust-detail-sub');
  const avatarBox = document.getElementById('cust-detail-avatar-box');
  const footerStatus = document.getElementById('cust-detail-footer-status');

  // Loan Financials & Effective Stats
  const instCount = cust.totalInstalments || 52;
  const isDaily = cust.frequency === 'Daily' || instCount === 100;
  const unitLabel = isDaily ? 'Day' : 'Week';
  const effectiveStats = getCustomerEffectiveStats(cust);
  const totalPayable = instCount * (cust.instalmentAmount || 200);
  const totalPaid = effectiveStats.totalPaidAmount;
  const remainingBal = Math.max(0, totalPayable - totalPaid);
  const completionPct = totalPayable > 0 ? Math.min(100, Math.round((totalPaid / totalPayable) * 100)) : 0;

  if (nameEl) nameEl.textContent = cust.fullName;
  if (numBadge) numBadge.textContent = `#${cust.customerNumber}`;
  if (subEl) {
    subEl.innerHTML = `${cust.phone || 'No phone'} • 📍 ${cust.areaRoute || 'General'} • <span style="color: #b45309; font-weight: 700;">Bal: ${formatMoney(remainingBal)}</span> • Started: ${cust.startDate || '-'}`;
  }
  if (avatarBox) {
    avatarBox.innerHTML = `
      <div class="cust-avatar" style="width: 36px; height: 36px; border-radius: 50%; overflow: hidden; background: #e0e7ff; color: #3730a3; font-weight: 700; display: flex; align-items: center; justify-content: center; cursor: pointer;" onclick="openCustomerPhotoLightbox('${cust.id}', event)">
        ${cust.photoUrl ? `<img src="${cust.photoUrl}" style="width: 100%; height: 100%; object-fit: cover;">` : (cust.fullName || 'C').slice(0, 2).toUpperCase()}
      </div>
    `;
  }

  // Multi-Loan Tabs
  const allLoans = state.customers
    .filter(c => c.customerNumber.toString() === cust.customerNumber.toString())
    .sort((a, b) => (Number(a.loanNumber) || 1) - (Number(b.loanNumber) || 1));

  const tabsContainer = document.getElementById('cust-detail-loan-tabs');
  if (tabsContainer) {
    tabsContainer.innerHTML = allLoans.map(l => {
      const isCurrent = l.id === loanId;
      const lNum = l.loanNumber || 1;
      const lStats = getCustomerEffectiveStats(l);
      let statusTag = l.isSettled ? '🤝 Settled' : (lStats.isOverdue ? '⚠️ Due' : 'Active');
      return `
        <button type="button" class="cust-loan-tab-btn ${isCurrent ? 'active' : ''}" onclick="switchCustomerDetailLoan('${l.id}')">
          <span>Loan #${lNum}</span>
          <span style="font-size: 11px; opacity: 0.85;">(${statusTag})</span>
        </button>
      `;
    }).join('');
  }

  // Next Due Instalment
  let nextDueSeq = 1;
  const insts = effectiveStats.insts;
  for (let i = 1; i <= instCount; i++) {
    const itm = insts[i - 1];
    if (!itm || itm.status !== 'Received') {
      nextDueSeq = i;
      break;
    }
  }
  const nextDueInst = insts[nextDueSeq - 1];
  const isNextPartial = nextDueInst && nextDueInst.status === 'Partial';
  const nextRemainingDue = isNextPartial ? Math.max(0, (cust.instalmentAmount || 0) - (Number(nextDueInst.paidAmount) || 0)) : (cust.instalmentAmount || 0);

  // Checkbox Grid (With vibrant green checkmarks for paid and orange for partial)
  let gridCellsHtml = '';
  for (let sq = 1; sq <= instCount; sq++) {
    const inst = insts[sq - 1];
    let btnClass = 'is-pending sched-box-pending';
    let btnIcon = '';
    let instTitle = `${unitLabel} #${sq}: Pending (${formatMoney(cust.instalmentAmount)})`;

    if (inst && inst.status === 'Received') {
      btnClass = 'is-paid sched-box-paid';
      btnIcon = '✓';
      instTitle = `${unitLabel} #${sq}: Paid (${formatMoney(inst.paidAmount || cust.instalmentAmount)}) on ${inst.paidDate || '-'}. Tap to undo.`;
    } else if (inst && inst.status === 'Partial') {
      btnClass = 'is-partial sched-box-partial';
      const pAmt = Number(inst.paidAmount) || 0;
      btnIcon = `<span class="sched-partial-amt"><span class="sched-partial-currency">₹</span>${pAmt}</span>`;
      instTitle = `${unitLabel} #${sq}: Partial (Rec'd: ${formatMoney(pAmt)} • Pending: ${formatMoney((cust.instalmentAmount || 0) - pAmt)}). Tap to complete.`;
    }

    gridCellsHtml += `
      <div class="sched-cell">
        <span class="sched-num-label">${sq}</span>
        <button type="button" 
                class="sched-box-btn ${btnClass}" 
                onclick="handleDetailInstalmentClick('${cust.id}', ${sq}, event)" 
                title="${instTitle}">
          ${btnIcon}
        </button>
      </div>
    `;
  }

  // Pending Modifications
  const pendingMod = state.pendingModifications && state.pendingModifications[cust.id];
  const hasPendingMod = hasActualPendingChanges(cust.id);

  if (footerStatus) {
    footerStatus.innerHTML = hasPendingMod && pendingMod.sessionAmount > 0
      ? `<strong style="color: #15803d;">Unsaved collection: + ${formatMoney(pendingMod.sessionAmount)}</strong>`
      : `<span>Loan #${cust.loanNumber || 1} • ${effectiveStats.paidCount}/${instCount} Paid (${completionPct}%)</span>`;
  }

  const container = document.getElementById('cust-detail-loan-content');
  if (!container) return;

  container.innerHTML = `
    <!-- Financial Balances Banner -->
    <div style="background: #f8fafc; border: 1.5px solid #e2e8f0; border-radius: 12px; padding: 12px 16px; margin-bottom: 12px;">
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: 10px; margin-bottom: 8px;">
        <div>
          <span style="font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 700;">Principal</span>
          <div style="font-size: 16px; font-weight: 800; color: #0f172a;">${formatMoney(cust.givenAmount)}</div>
        </div>
        <div>
          <span style="font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 700;">Collected</span>
          <div style="font-size: 16px; font-weight: 800; color: #15803d;">${formatMoney(totalPaid)}</div>
        </div>
        <div>
          <span style="font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 700;">Balance Payable</span>
          <div style="font-size: 16px; font-weight: 800; color: #b45309;">${formatMoney(remainingBal)}</div>
        </div>
        <div>
          <span style="font-size: 11px; color: #64748b; text-transform: uppercase; font-weight: 700;">Progress</span>
          <div style="font-size: 16px; font-weight: 800; color: #2563eb;">${completionPct}% (${effectiveStats.paidCount}/${instCount})</div>
        </div>
      </div>
      <div class="progress-bar-bg" style="height: 8px;">
        <div class="progress-bar-fill" style="width: ${completionPct}%;"></div>
      </div>
    </div>

    <!-- Quick Action Toolbar: Pay Pending or Partial Pay -->
    <div class="sched-quick-toolbar" style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 12px; padding: 10px 14px; background: #ffffff; border: 1.5px solid #e2e8f0; border-radius: 10px; font-size: 13px; flex-wrap: wrap; gap: 8px; box-shadow: 0 1px 3px rgba(0,0,0,0.04);">
      <div style="color: #334155; font-weight: 600;">
        <span>${unitLabel} #${nextDueSeq}:</span>
        ${isNextPartial 
          ? `<span style="color: #b45309; font-weight: 700; margin-left: 4px;">½ Partial (Rec'd: ${formatMoney(nextDueInst.paidAmount || 0)} • Pending: ${formatMoney(nextRemainingDue)})</span>`
          : `<span style="color: #1e40af; font-weight: 700; margin-left: 4px;">Due ${formatMoney(cust.instalmentAmount)}</span>`
        }
        <span style="margin-left: 8px; color: #b45309; font-weight: 700; background: #fef3c7; padding: 2px 7px; border-radius: 4px; border: 1px solid #f59e0b;">Bal: ${formatMoney(remainingBal)}</span>
      </div>
      <div style="display: flex; gap: 8px; align-items: center;">
        <button type="button" class="btn btn-sm" style="background: #fef3c7; color: #b45309; border: 1px solid #f59e0b; font-weight: 700; padding: 5px 12px; border-radius: 6px; cursor: pointer;" onclick="openPartialPayModal('${cust.id}', ${nextDueSeq})">
          ½ Partial Pay
        </button>
        <button type="button" class="btn btn-sm" style="background: #ecfdf5; color: #047857; border: 1px solid #a7f3d0; font-weight: 700; padding: 5px 12px; border-radius: 6px; cursor: pointer;" onclick="handleDetailInstalmentClick('${cust.id}', ${nextDueSeq}, event)">
          ✓ Pay ${isNextPartial ? 'Remaining ' : ''}${formatMoney(nextRemainingDue)}
        </button>
      </div>
    </div>

    <!-- 4-Row Instalment Matrix -->
    <div style="margin-bottom: 12px;">
      <div style="font-size: 12px; font-weight: 700; color: #475569; margin-bottom: 6px; display: flex; justify-content: space-between;">
        <span>Schedule Matrix (${unitLabel}s 1 to ${instCount})</span>
        <span style="font-size: 11px; color: #64748b;">Tap any cell to toggle receipt</span>
      </div>
      <div class="sched-4row-grid" style="${instCount === 100 ? 'grid-template-columns: repeat(10, 1fr);' : ''}">
        ${gridCellsHtml}
      </div>
    </div>

    <!-- Unsaved Modifications Banner -->
    ${hasPendingMod && pendingMod.sessionAmount > 0 ? `
      <div class="sched-modified-bar" style="margin-bottom: 14px; padding: 12px 16px; border-radius: 10px; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <strong style="color: #166534; font-size: 14px;">Unsaved Collection:</strong>
          <span style="color: #15803d; font-size: 17px; font-weight: 800; margin-left: 6px;">+ ${formatMoney(pendingMod.sessionAmount)}</span>
        </div>
        <button type="button" class="btn-drawer-save" onclick="saveCustomerModificationsDetail('${cust.id}')">
          💾 Save Collection (${formatMoney(pendingMod.sessionAmount)})
        </button>
      </div>
    ` : ''}

    <!-- Pro Suite Direct Tools -->
    <div style="display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; padding-top: 12px; border-top: 1px solid #f1f5f9;">
      <button type="button" class="btn btn-outline btn-sm" onclick="openPassbookModal('${cust.id}')">
        📖 Passbook
      </button>
      <button type="button" class="btn btn-outline btn-sm" onclick="openThermalSlipModal('${cust.id}', ${nextDueSeq})">
        🧾 Thermal Slip
      </button>
      <button type="button" class="btn btn-outline btn-sm" onclick="openKycViewerModal('${cust.id}')">
        🪪 KYC Docs
      </button>
      ${cust.isSettled ? `
        <button type="button" class="btn btn-outline btn-sm" onclick="openNOCModal('${cust.id}')" style="color: #047857; border-color: #a7f3d0; background: #ecfdf5;">
          🤝 NOC Certificate
        </button>
      ` : ''}
      <button type="button" class="btn btn-outline btn-sm" onclick="openEditCustomerModal('${cust.id}')">
        ✏️ Edit Terms
      </button>
    </div>
  `;
}

function handleDetailInstalmentClick(loanId, sq, event) {
  if (event) event.stopPropagation();
  handleInstalmentClick(loanId, sq, event);
  renderCustomerDetailModalContent(loanId);
}

function saveCustomerModificationsDetail(loanId) {
  saveCustomerModifications(loanId);
  renderCustomerDetailModalContent(loanId);
}

function requestCloseCustomerDetailModal() {
  const activeId = state.activeDetailCustomerId;
  if (activeId && hasActualPendingChanges(activeId)) {
    const pending = state.pendingModifications[activeId];
    const amountStr = pending && pending.sessionAmount ? formatMoney(pending.sessionAmount) : '';
    const shouldSave = confirm(`You have unsaved collections (${amountStr}) for this customer.\n\nClick OK to SAVE before closing.\nClick Cancel to DISCARD unsaved changes and close.`);
    if (shouldSave) {
      saveCustomerModifications(activeId);
    } else {
      discardCustomerModifications(activeId);
    }
  }
  closeCustomerDetailModal();
}

function closeCustomerDetailModal() {
  const modal = document.getElementById('modal-customer-detail');
  const backdrop = document.getElementById('customer-detail-backdrop');
  if (modal) modal.style.display = 'none';
  if (backdrop) backdrop.style.display = 'none';
  state.activeDetailCustomerId = null;
  if (!document.querySelector('.photo-lightbox-backdrop:not([style*="display: none"]), .modal-overlay.active')) {
    document.body.classList.remove('modal-open');
  }
}

// ========================================================
// 3. ROLE-BASED ACCESS CONTROL & DASHBOARD BREAKDOWN
// ========================================================
function applyRoleBasedPermissions() {
  const currentUser = getCurrentUser();
  const isAdmin = currentUser && currentUser.role === 'Admin';

  const breakdownCard = document.getElementById('dashboard-collector-breakdown');
  if (breakdownCard) {
    breakdownCard.style.display = isAdmin ? 'block' : 'none';
  }
}

// Helper to accurately aggregate today's collections across audit ledger transactions AND customer instalments
function getTodayCollectorTransactions() {
  const todayStr = getISTDateString();
  const recordedKeys = new Set();
  const items = [];

  if (state.transactions && Array.isArray(state.transactions)) {
    state.transactions.forEach(t => {
      if ((t.date === todayStr || t.date === 'Today') && t.type !== 'undo') {
        const cust = (state.customers || []).find(c => 
          (c.id && c.id === t.customerId) || 
          (c.customerNumber && c.customerNumber.toString() === (t.customerNumber || '').toString())
        );
        items.push({
          customerId: t.customerId || (cust ? cust.id : ''),
          customerNumber: t.customerNumber || (cust ? cust.customerNumber : ''),
          loanNumber: Number(t.loanNumber) || (cust ? Number(cust.loanNumber) : 1) || 1,
          customerName: t.customerName || (cust ? cust.fullName : 'Customer'),
          instalmentNumber: t.instalmentNumber,
          receiptNumber: t.receiptNumber || '',
          amount: Number(t.amount) || 0,
          collector: t.collector || 'Admin',
          collectorId: t.collectorId || null
        });
        if (t.customerId && t.instalmentNumber) {
          recordedKeys.add(`${t.customerId}_${t.instalmentNumber}`);
        }
      }
    });
  }

  // Fallback: also scan active customer instalments paid today not yet logged as transaction rows
  (state.customers || []).forEach((c) => {
    const cLoanNum = Number(c.loanNumber) || 1;
    const cInstAmt = Number(c.instalmentAmount) || 200;
    (c.instalments || []).forEach((inst) => {
      if (inst && (inst.status === 'Received' || inst.status === 'Partial') && (inst.paidDate === todayStr || inst.paidDate === 'Today')) {
        const key = `${c.id}_${inst.number}`;
        if (!recordedKeys.has(key)) {
          const instPaid = (inst.status === 'Received') ? (Number(inst.paidAmount) || cInstAmt) : (Number(inst.paidAmount) || 0);
          items.push({
            customerId: c.id,
            customerNumber: c.customerNumber,
            loanNumber: cLoanNum,
            customerName: c.fullName,
            instalmentNumber: inst.number,
            receiptNumber: inst.receiptNumber || `REC-${inst.number}`,
            amount: instPaid,
            collector: inst.paidBy || 'Admin',
            collectorId: null
          });
        }
      }
    });
  });

  return items;
}

function renderCollectorBreakdownWidget() {
  const breakdownCard = document.getElementById('dashboard-collector-breakdown');
  const cardsContainer = document.getElementById('collector-breakdown-cards');
  if (!breakdownCard || !cardsContainer) return;

  const currentUser = getCurrentUser();
  const isAdmin = currentUser && currentUser.role === 'Admin';

  if (!isAdmin) {
    breakdownCard.style.display = 'none';
    return;
  }
  breakdownCard.style.display = 'block';

  const todayTxns = getTodayCollectorTransactions();

  const roster = Array.isArray(state.settings.collectors) ? state.settings.collectors : [];
  const rosterCollectorKeys = new Set();
  roster.forEach(c => {
    if (c.name) rosterCollectorKeys.add(c.name.trim().toLowerCase());
    if (c.email) rosterCollectorKeys.add(c.email.trim().toLowerCase());
    if (c.id) rosterCollectorKeys.add(c.id.toString().toLowerCase());
  });

  // 1. Admin Personal Collections (All collections attributed to admin or not claimed by roster field collectors)
  const adminTxns = todayTxns.filter(t => {
    const colStr = (t.collector || '').trim().toLowerCase();
    if (!colStr || colStr === 'admin' || colStr.includes('admin')) return true;
    if (currentUser && currentUser.user && colStr === currentUser.user.trim().toLowerCase()) return true;
    if (currentUser && currentUser.email && colStr === currentUser.email.trim().toLowerCase()) return true;
    if (state.settings.adminEmail && colStr === state.settings.adminEmail.trim().toLowerCase()) return true;
    return !rosterCollectorKeys.has(colStr);
  });
  const adminTotal = adminTxns.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
  const adminCount = adminTxns.length;

  let html = `
    <div class="collector-card admin-collector">
      <div class="collector-card-title">
        <span style="display: flex; align-items: center; gap: 6px;">
          <span>👑</span> Admin (Personal Collections)
        </span>
        <span class="badge" style="background: #f3e8ff; color: #7c3aed; font-size: 11px; padding: 2px 8px; border-radius: 4px; font-weight: 700;">Owner</span>
      </div>
      <div class="collector-card-amount">₹ ${adminTotal.toLocaleString('en-IN')}</div>
      <div class="collector-card-meta">
        <span>🧾 ${adminCount} receipts issued today</span>
      </div>
      <div class="collector-card-actions">
        <button type="button" class="btn btn-outline btn-sm" onclick="openCollectorHandoverModal('Admin')" style="width: 100%; font-size: 11.5px; padding: 4px 10px; background: #ffffff; color: #7c3aed; border-color: #d8b4fe; font-weight: 700;">
          📄 Personal Audit Slip
        </button>
      </div>
    </div>
  `;

  // 2. Field Collectors from Roster
  roster.forEach(col => {
    const colTxns = todayTxns.filter(t => 
      t.collector === col.name || t.collector === col.email || (t.collectorId && t.collectorId === col.id)
    );
    const colTotal = colTxns.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);
    const colCount = colTxns.length;
    const isActive = col.active !== false;

    html += `
      <div class="collector-card field-collector">
        <div class="collector-card-title">
          <span style="display: flex; align-items: center; gap: 6px;">
            <span>🛵</span> ${col.name}
          </span>
          <span class="badge" style="background: ${isActive ? '#ecfdf5' : '#fef2f2'}; color: ${isActive ? '#047857' : '#b91c1c'}; border: 1px solid ${isActive ? '#a7f3d0' : '#fca5a5'}; font-size: 10.5px; padding: 2px 6px; border-radius: 4px;">
            ${isActive ? 'Active' : 'Inactive'}
          </span>
        </div>
        <div class="collector-card-amount">₹ ${colTotal.toLocaleString('en-IN')}</div>
        <div class="collector-card-meta">
          <span>📍 ${col.route || 'Field Route'} • 🧾 ${colCount} receipts today</span>
        </div>
        <div class="collector-card-actions">
          <button type="button" class="btn btn-outline btn-sm" onclick="openCollectorHandoverModal('${col.name}')" style="width: 100%; font-size: 11.5px; padding: 4px 10px; background: #ffffff; color: #2563eb; border-color: #bfdbfe; font-weight: 700;">
            📄 Handover Slip / Cash Tally
          </button>
        </div>
      </div>
    `;
  });

  cardsContainer.innerHTML = html;
}

function openCollectorHandoverModal(operatorName) {
  const modal = document.getElementById('modal-collector-handover');
  const content = document.getElementById('collector-handover-slip-content');
  const title = document.getElementById('collector-handover-title');
  if (!modal || !content) return;

  const todayStr = getISTDateString();
  const isAdm = operatorName === 'Admin';
  if (title) {
    title.innerHTML = isAdm 
      ? `<span>👑</span> Admin Personal Collections Audit Slip` 
      : `<span>🛵</span> Field Collector Handover Slip: ${operatorName}`;
  }

  const allTodayTxns = getTodayCollectorTransactions();
  const roster = Array.isArray(state.settings.collectors) ? state.settings.collectors : [];
  const rosterCol = roster.find(c => c.name === operatorName || c.email === operatorName);

  const txns = allTodayTxns.filter(t => {
    if (isAdm) {
      return !t.collector || t.collector === 'Admin' || t.collector.toLowerCase().includes('admin');
    }
    return t.collector === operatorName || (rosterCol && (t.collector === rosterCol.name || t.collector === rosterCol.email || t.collectorId === rosterCol.id));
  });

  const totalAmount = txns.reduce((sum, t) => sum + (Number(t.amount) || 0), 0);

  let rowsHtml = '';
  txns.forEach((t, idx) => {
    rowsHtml += `
      <tr>
        <td style="padding: 6px 8px; border-bottom: 1px solid #f1f5f9;">${idx + 1}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #f1f5f9; font-weight: 700;">#${t.customerNumber} - ${t.customerName}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #f1f5f9;">L${t.loanNumber || 1} • W#${t.instalmentNumber}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #f1f5f9; font-family: monospace; font-size: 11px;">${t.receiptNumber || '-'}</td>
        <td style="padding: 6px 8px; border-bottom: 1px solid #f1f5f9; text-align: right; font-weight: 700; color: #16a34a;">₹ ${Number(t.amount || 0).toLocaleString('en-IN')}</td>
      </tr>
    `;
  });

  content.innerHTML = `
    <div style="font-family: inherit; color: #0f172a;">
      <div style="text-align: center; margin-bottom: 12px; border-bottom: 2px solid #0f172a; padding-bottom: 8px;">
        <h3 style="margin: 0; font-size: 16px; font-weight: 800;">${state.settings.businessName || 'JSR FINANCE'}</h3>
        <div style="font-size: 12px; color: #475569; font-weight: 700; margin-top: 2px;">
          ${isAdm ? 'ADMIN PERSONAL COLLECTIONS AUDIT SLIP' : 'FIELD COLLECTOR CASH HANDOVER & VERIFICATION SLIP'}
        </div>
        <div style="font-size: 11px; color: #64748b;">Operator: <strong>${operatorName}</strong> • Date: ${todayStr}</div>
      </div>

      <div style="background: #f8fafc; border: 1px solid #e2e8f0; border-radius: 8px; padding: 10px 14px; margin-bottom: 12px; display: flex; justify-content: space-between; align-items: center;">
        <div>
          <span style="font-size: 11.5px; color: #64748b; font-weight: 600;">RECEIPTS COUNT</span>
          <div style="font-size: 18px; font-weight: 800; color: #0f172a;">${txns.length} Receipts</div>
        </div>
        <div style="text-align: right;">
          <span style="font-size: 11.5px; color: #64748b; font-weight: 600;">TOTAL CASH COLLECTED</span>
          <div style="font-size: 20px; font-weight: 800; color: #15803d;">₹ ${totalAmount.toLocaleString('en-IN')}</div>
        </div>
      </div>

      <div style="max-height: 240px; overflow-y: auto; border: 1px solid #e2e8f0; border-radius: 6px; margin-bottom: 14px;">
        <table class="data-table" style="font-size: 11.5px; margin: 0;">
          <thead>
            <tr style="background: #f1f5f9;">
              <th style="padding: 6px 8px;">#</th>
              <th style="padding: 6px 8px;">Borrower</th>
              <th style="padding: 6px 8px;">Instalment</th>
              <th style="padding: 6px 8px;">Receipt #</th>
              <th style="padding: 6px 8px; text-align: right;">Amount</th>
            </tr>
          </thead>
          <tbody>
            ${rowsHtml || '<tr><td colspan="5" style="text-align: center; padding: 16px; color: #94a3b8;">No collections recorded today for this operator.</td></tr>'}
          </tbody>
        </table>
      </div>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 20px; margin-top: 20px; padding-top: 14px; border-top: 1px dashed #cbd5e1; text-align: center;">
        <div>
          <div style="height: 40px; border-bottom: 1px solid #94a3b8;"></div>
          <div style="font-size: 11px; font-weight: 700; color: #475569; margin-top: 4px;">
            ${isAdm ? 'Collector / Admin Signature' : 'Field Collector Signature (' + operatorName + ')'}
          </div>
        </div>
        <div>
          <div style="height: 40px; border-bottom: 1px solid #94a3b8;"></div>
          <div style="font-size: 11px; font-weight: 700; color: #475569; margin-top: 4px;">Cashier / Auditor Acknowledgment</div>
        </div>
      </div>
    </div>
  `;

  modal.classList.add('active');
  document.body.classList.add('modal-open');
}

function printCollectorHandoverSlip() {
  const content = document.getElementById('collector-handover-slip-content');
  if (!content) return;
  const printWindow = window.open('', '_blank');
  printWindow.document.write(`
    <!DOCTYPE html>
    <html>
    <head>
      <title>Collection Handover Slip</title>
      <style>
        body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; padding: 20px; color: #000; }
        table { width: 100%; border-collapse: collapse; }
        th, td { border-bottom: 1px solid #ddd; padding: 6px; font-size: 12px; }
        @media print { body { padding: 0; } }
      </style>
    </head>
    <body>
      ${content.innerHTML}
      <script>
        window.onload = function() { window.print(); window.close(); }
      </script>
    </body>
    </html>
  `);
  printWindow.document.close();
}

// ========================================================
// 4. FIELD COLLECTOR ROSTER (SETTINGS)
// ========================================================
function renderCollectorsRoster() {
  const container = document.getElementById('collectors-roster-container');
  if (!container) return;

  const collectors = Array.isArray(state.settings.collectors) ? state.settings.collectors : [];
  if (collectors.length === 0) {
    container.innerHTML = `
      <div style="padding: 16px; text-align: center; color: #64748b; font-size: 12.5px;">
        No field collectors registered yet. Click <strong>+ Add Field Collector</strong> above to register a Google account.
      </div>
    `;
    return;
  }

  // 1. Desktop Table View
  let tableHtml = `
    <div class="roster-desktop-view">
      <table class="data-table" style="margin: 0; font-size: 12.5px; width: 100%;">
        <thead>
          <tr>
            <th style="padding: 8px 12px;">Collector Name</th>
            <th style="padding: 8px 12px;">Google Email</th>
            <th style="padding: 8px 12px;">Assigned Route</th>
            <th style="padding: 8px 12px;">Phone</th>
            <th style="padding: 8px 12px;">Status</th>
            <th style="padding: 8px 12px; text-align: right;">Actions</th>
          </tr>
        </thead>
        <tbody>
  `;

  // 2. Mobile Responsive Cards View
  let cardsHtml = `<div class="roster-mobile-view">`;

  collectors.forEach(c => {
    const isActive = c.active !== false;

    tableHtml += `
      <tr>
        <td style="padding: 8px 12px; font-weight: 700; color: #0f172a;">${c.name}</td>
        <td style="padding: 8px 12px; font-family: monospace; color: #2563eb;">${c.email}</td>
        <td style="padding: 8px 12px;">${c.route || 'General'}</td>
        <td style="padding: 8px 12px;">${c.phone || '-'}</td>
        <td style="padding: 8px 12px;">
          <span class="badge" style="background: ${isActive ? '#ecfdf5' : '#fef2f2'}; color: ${isActive ? '#047857' : '#b91c1c'}; border: 1px solid ${isActive ? '#a7f3d0' : '#fca5a5'}; font-size: 11px; padding: 2px 6px; border-radius: 4px;">
            ${isActive ? '● Active' : '○ Inactive'}
          </span>
        </td>
        <td style="padding: 8px 12px; text-align: right; white-space: nowrap;">
          <button type="button" class="btn btn-outline btn-sm" onclick="openEditCollectorModal('${c.id}')" style="font-size: 11px; padding: 2px 8px; margin-right: 4px;">Edit</button>
          <button type="button" class="btn btn-outline btn-sm" onclick="toggleCollectorStatus('${c.id}')" style="font-size: 11px; padding: 2px 8px; color: ${isActive ? '#b91c1c' : '#047857'}; border-color: ${isActive ? '#fca5a5' : '#a7f3d0'};">
            ${isActive ? 'Deactivate' : 'Activate'}
          </button>
        </td>
      </tr>
    `;

    cardsHtml += `
      <div class="roster-card">
        <div class="roster-card-header">
          <span class="roster-card-name">${c.name}</span>
          <span class="badge" style="background: ${isActive ? '#ecfdf5' : '#fef2f2'}; color: ${isActive ? '#047857' : '#b91c1c'}; border: 1px solid ${isActive ? '#a7f3d0' : '#fca5a5'}; font-size: 10.5px; padding: 2px 6px; border-radius: 4px;">
            ${isActive ? '● Active' : '○ Inactive'}
          </span>
        </div>
        <div class="roster-card-email">${c.email}</div>
        <div class="roster-card-details">
          <span>📍 Route: <strong>${c.route || 'General'}</strong></span>
          <span>📞 Phone: <strong>${c.phone || '-'}</strong></span>
        </div>
        <div class="roster-card-actions">
          <button type="button" class="btn btn-outline btn-sm" onclick="openEditCollectorModal('${c.id}')" style="font-size: 11.5px; flex: 1;">Edit</button>
          <button type="button" class="btn btn-outline btn-sm" onclick="toggleCollectorStatus('${c.id}')" style="font-size: 11.5px; flex: 1; color: ${isActive ? '#b91c1c' : '#047857'}; border-color: ${isActive ? '#fca5a5' : '#a7f3d0'};">
            ${isActive ? 'Deactivate' : 'Activate'}
          </button>
        </div>
      </div>
    `;
  });

  tableHtml += `</tbody></table></div>`;
  cardsHtml += `</div>`;

  container.innerHTML = tableHtml + cardsHtml;
}

function openAddCollectorModal() {
  document.getElementById('collector-modal-title').textContent = '🛵 Add Field Collector';
  document.getElementById('collector-form-id').value = '';
  document.getElementById('collector-form-name').value = '';
  document.getElementById('collector-form-email').value = '';
  document.getElementById('collector-form-phone').value = '';
  document.getElementById('collector-form-route').value = '';
  document.getElementById('collector-form-active').checked = true;
  openModal('modal-collector-editor');
}

function openEditCollectorModal(collectorId) {
  const c = (state.settings.collectors || []).find(col => col.id === collectorId);
  if (!c) return;

  document.getElementById('collector-modal-title').textContent = `🛵 Edit Collector: ${c.name}`;
  document.getElementById('collector-form-id').value = c.id;
  document.getElementById('collector-form-name').value = c.name;
  document.getElementById('collector-form-email').value = c.email;
  document.getElementById('collector-form-phone').value = c.phone || '';
  document.getElementById('collector-form-route').value = c.route || '';
  document.getElementById('collector-form-active').checked = c.active !== false;
  openModal('modal-collector-editor');
}

function handleSaveCollector(event) {
  event.preventDefault();
  const id = document.getElementById('collector-form-id').value;
  const name = document.getElementById('collector-form-name').value.trim();
  const email = document.getElementById('collector-form-email').value.trim().toLowerCase();
  const phone = document.getElementById('collector-form-phone').value.trim();
  const route = document.getElementById('collector-form-route').value.trim() || 'General Route';
  const active = document.getElementById('collector-form-active').checked;

  if (!name || !email) {
    alert('Please enter both Collector Name and valid Google Email.');
    return;
  }

  if (!Array.isArray(state.settings.collectors)) {
    state.settings.collectors = [];
  }

  if (id) {
    const existing = state.settings.collectors.find(c => c.id === id);
    if (existing) {
      existing.name = name;
      existing.email = email;
      existing.phone = phone;
      existing.route = route;
      existing.active = active;
    }
  } else {
    state.settings.collectors.push({
      id: 'col_' + Date.now(),
      name,
      email,
      phone,
      route,
      active
    });
  }

  saveData();
  if (typeof syncSettingsToFirestore === 'function') {
    syncSettingsToFirestore(state.settings);
  }
  closeModal('modal-collector-editor');
  renderCollectorsRoster();
  showToast(`✓ Field Collector saved: ${name}`);
}

function toggleCollectorStatus(collectorId) {
  const c = (state.settings.collectors || []).find(col => col.id === collectorId);
  if (!c) return;
  c.active = !c.active;
  saveData();
  if (typeof syncSettingsToFirestore === 'function') {
    syncSettingsToFirestore(state.settings);
  }
  renderCollectorsRoster();
  showToast(`✓ Collector ${c.name} ${c.active ? 'activated' : 'deactivated'}`);
}

// ========================================================
// 5. LOCAL-FIRST OFFLINE COLLECTION MODE & AUTO-SYNC ENGINE
// ========================================================
let _isSyncingOfflineQueue = false;
let _currentConflictItem = null;

function updateOfflineSyncBadge() {
  const badge = document.getElementById('offline-sync-badge');
  const icon = document.getElementById('offline-sync-icon');
  const text = document.getElementById('offline-sync-text');
  if (!badge) return;

  const queue = state.offlineSyncQueue || [];
  const isOnline = navigator.onLine;

  badge.classList.remove('online', 'pending', 'offline');

  if (!isOnline) {
    badge.classList.add('offline');
    if (icon) icon.textContent = '📡';
    if (text) {
      text.textContent = `Offline · ${queue.length} Pending`;
      text.style.color = '#991b1b';
    }
  } else if (queue.length > 0) {
    badge.classList.add('pending');
    if (icon) icon.textContent = '⏳';
    if (text) {
      text.textContent = `${queue.length} to Sync`;
      text.style.color = '#b45309';
    }
  } else {
    badge.classList.add('online');
    if (icon) icon.textContent = '☁️';
    if (text) {
      text.textContent = 'All Synced';
      text.style.color = '#16a34a';
    }
  }
}

function setupOfflineSyncListeners() {
  window.addEventListener('online', () => {
    updateOfflineSyncBadge();
    showToast('📶 Internet connection restored. Syncing offline collections...');
    triggerOfflineSync();
  });

  window.addEventListener('offline', () => {
    updateOfflineSyncBadge();
    showToast('📡 You are now in Offline Mode. Collections will save locally.');
  });

  window.addEventListener('focus', () => {
    if (navigator.onLine && (state.offlineSyncQueue || []).length > 0) {
      triggerOfflineSync();
    }
  });

  // Background sync check every 20 seconds
  setInterval(() => {
    if (navigator.onLine && (state.offlineSyncQueue || []).length > 0 && !_isSyncingOfflineQueue) {
      triggerOfflineSync();
    }
  }, 20000);
}

function triggerManualOfflineSync() {
  if (!navigator.onLine) {
    alert('Device is currently offline. Connect to mobile data / Wi-Fi to sync with the cloud.');
    return;
  }
  showToast('🔄 Checking for offline transactions to sync...');
  triggerOfflineSync();
}

async function triggerOfflineSync() {
  if (_isSyncingOfflineQueue || !navigator.onLine || !state.offlineSyncQueue || state.offlineSyncQueue.length === 0) {
    updateOfflineSyncBadge();
    return;
  }

  if (typeof firestoreDb === 'undefined' || !firestoreDb) {
    updateOfflineSyncBadge();
    return;
  }

  _isSyncingOfflineQueue = true;
  updateOfflineSyncBadge();

  try {
    const item = state.offlineSyncQueue[0];
    if (!item) {
      _isSyncingOfflineQueue = false;
      return;
    }

    // Conflict Check against cloud customer record
    const custDoc = await firestoreDb.collection('customers').doc(item.customerId).get();
    if (custDoc && custDoc.exists) {
      const cloudCust = custDoc.data();
      const cloudInst = (cloudCust.instalments || []).find(i => i && i.number === item.instalmentNumber);
      
      const normCloudReceipt = (cloudInst?.receiptNumber || '').replace(/^PROV-/, '');
      const normItemReceipt = (item.receiptNumber || '').replace(/^PROV-/, '');
      const normProvReceipt = (item.provisionalReceipt || '').replace(/^PROV-/, '');
      const isSameReceipt = normCloudReceipt && (normCloudReceipt === normItemReceipt || normCloudReceipt === normProvReceipt);

      // Check if this cloud instalment was settled by the same collector for the same amount or session
      const isSameCollector = cloudInst && cloudInst.paidBy && item.collector && (
        cloudInst.paidBy.trim().toLowerCase() === item.collector.trim().toLowerCase()
      );
      const isSameAmount = cloudInst && (Number(cloudInst.paidAmount) === Number(item.amount) || Number(cloudInst.dueAmount) === Number(item.amount));
      const isOwnConfirmedSave = (cloudCust && cloudCust.lastModifiedSession && typeof CURRENT_SESSION_ID !== 'undefined' && cloudCust.lastModifiedSession === CURRENT_SESSION_ID);
      const isSelfSync = isSameReceipt || (isSameCollector && isSameAmount) || isOwnConfirmedSave;

      // If cloud instalment already settled by a DIFFERENT operator or conflicting payment
      if (cloudInst && cloudInst.status === 'Received' && !isSelfSync) {
        showSyncConflictModal(item, cloudInst, cloudCust);
        _isSyncingOfflineQueue = false;
        return;
      }
    }

    // No conflict -> Push transaction to Firestore
    await firestoreDb.collection('transactions').doc(item.id || item.offlineTxnId).set({
      ...item,
      syncedAt: new Date().toISOString()
    });

    // Remove from local queue
    state.offlineSyncQueue.shift();
    try {
      localStorage.setItem('jsr_finance_offline_queue', JSON.stringify(state.offlineSyncQueue));
    } catch (e) {}

    updateOfflineSyncBadge();
    _isSyncingOfflineQueue = false;

    // Process next item recursively
    if (state.offlineSyncQueue.length > 0) {
      triggerOfflineSync();
    } else {
      showToast('✓ All offline collections successfully synced to cloud!');
    }
  } catch (err) {
    console.warn('Offline sync attempt error:', err);
    _isSyncingOfflineQueue = false;
    updateOfflineSyncBadge();
  }
}

function showSyncConflictModal(localItem, serverItem, cloudCust) {
  _currentConflictItem = localItem;
  const modal = document.getElementById('sync-conflict-backdrop');
  const details = document.getElementById('sync-conflict-details');
  if (!modal || !details) return;

  // Determine exact server operator name who marked it on cloud
  let serverPaidBy = serverItem.paidBy;
  if (!serverPaidBy || serverPaidBy === 'Another Operator' || serverPaidBy === 'Admin') {
    const normReceipt = (serverItem.receiptNumber || '').replace(/^PROV-/, '');
    const matchedTxn = (state.transactions || []).find(t => 
      (t.receiptNumber && t.receiptNumber.replace(/^PROV-/, '') === normReceipt) ||
      (t.customerId === localItem.customerId && t.instalmentNumber === localItem.instalmentNumber && (Number(t.loanNumber) || 1) === (Number(localItem.loanNumber) || 1) && t.type !== 'undo')
    );
    if (matchedTxn && matchedTxn.collector) {
      serverPaidBy = matchedTxn.collector;
    } else {
      // Check registered collectors roster by email or ID if available
      const collectorsList = (state && state.settings && Array.isArray(state.settings.collectors)) ? state.settings.collectors : [];
      if (collectorsList.length > 0) {
        const found = collectorsList.find(c => c.name && c.name.toLowerCase().includes('suri'));
        if (found) serverPaidBy = found.name;
      }
    }
  }

  const localCollector = localItem.collector || ((getCurrentUser() && getCurrentUser().user) ? getCurrentUser().user : 'Surendra Singari');
  const sameBorrowerQueue = (state.offlineSyncQueue || []).filter(q => q.customerId === localItem.customerId && (Number(q.loanNumber) || 1) === (Number(localItem.loanNumber) || 1));
  const queueNotice = sameBorrowerQueue.length > 1 
    ? `<div style="margin-top:6px; font-size:12px; color:#1e40af; background:#dbeafe; padding:4px 8px; border-radius:6px; font-weight:600;">
        ℹ️ Note: You have ${sameBorrowerQueue.length} offline payments queued for this borrower. Selecting "Apply to Next" will naturally credit them sequentially without extra prompts.
       </div>`
    : '';

  details.innerHTML = `
    <div style="background: #fef2f2; border: 1.5px solid #fecaca; border-radius: 8px; padding: 12px; margin-bottom: 12px;">
      <strong style="color: #991b1b; font-size: 13.5px;">Cloud Conflict Detected:</strong>
      <div style="margin-top: 6px; font-size: 12.5px; color: #334155; line-height: 1.5;">
        Borrower: <strong>${localItem.customerName} (#${localItem.customerNumber}, Loan #${localItem.loanNumber})</strong><br>
        Instalment: <strong>Week #${localItem.instalmentNumber}</strong><br>
        Collected Offline By: <strong style="color: #2563eb;">${localCollector}</strong> (₹ ${Number(localItem.amount).toLocaleString('en-IN')})<br>
        Server Status: Already marked Paid by <strong style="color: #047857;">${serverPaidBy || 'Another Operator'}</strong> on cloud.
      </div>
      ${queueNotice}
    </div>
    <p style="font-size: 12.5px; color: #475569; margin: 0;">
      To prevent double-billing and preserve exact field collector attribution, choose how to apply this collection:
    </p>
  `;

  modal.style.display = 'flex';
  document.body.classList.add('modal-open');
}

function closeSyncConflictModal() {
  _currentConflictItem = null;
  const modal = document.getElementById('sync-conflict-backdrop');
  if (modal) modal.style.display = 'none';
  document.body.classList.remove('modal-open');
  _isSyncingOfflineQueue = false;
  updateOfflineSyncBadge();
}

function submitSyncConflictResolution() {
  if (!_currentConflictItem) return;
  const item = _currentConflictItem;
  const choice = document.querySelector('input[name="sync-conflict-choice"]:checked')?.value || 'next';

  const cust = state.customers.find(c => c.id === item.customerId);
  const collectorName = item.collector || 'Field Collector';

  if (choice === 'next') {
    // Atomic batch sliding: resolve ALL queued items for this borrower & loan to prevent cascade re-prompts
    const sameCustQueue = (state.offlineSyncQueue || []).filter(q => 
      q.customerId === item.customerId && (Number(q.loanNumber) || 1) === (Number(item.loanNumber) || 1)
    );
    sameCustQueue.sort((a, b) => (Number(a.instalmentNumber) || 0) - (Number(b.instalmentNumber) || 0));

    const totalInst = cust ? (cust.totalInstalments || 52) : 52;
    const unitLabel = (cust && (cust.frequency === 'Daily' || totalInst === 100)) ? 'Day' : 'Week';

    if (cust && cust.instalments) {
      sameCustQueue.forEach((queueItem) => {
        const nextPending = cust.instalments.find(i => i && i.status !== 'Received');
        const itemCollector = queueItem.collector || collectorName;
        const instAmt = Number(cust.instalmentAmount) || 200;

        if (nextPending) {
          nextPending.status = Number(queueItem.amount) >= instAmt ? 'Received' : 'Partial';
          nextPending.paidAmount = queueItem.amount;
          nextPending.paidBy = itemCollector;
          nextPending.paidDate = queueItem.date || getISTDateString();
          nextPending.paidTimestamp = queueItem.timestamp || getNowTimestamp();
          nextPending.receiptNumber = generateUniqueReceiptNumber(cust.customerNumber, cust.loanNumber, nextPending.number);

          recordTransaction({
            receiptNumber: nextPending.receiptNumber,
            customerId: cust.id,
            customerNumber: cust.customerNumber,
            loanNumber: cust.loanNumber || 1,
            customerName: cust.fullName,
            instalmentNumber: nextPending.number,
            amount: queueItem.amount,
            type: nextPending.status === 'Received' ? 'payment' : 'partial',
            collector: itemCollector,
            date: nextPending.paidDate,
            timestamp: nextPending.paidTimestamp,
            notes: `Applied from conflict resolution (originally collected for ${unitLabel} #${queueItem.instalmentNumber})`
          });
        } else {
          // Surplus collection beyond loan schedule recorded as advance
          recordTransaction({
            receiptNumber: `ADV-${Date.now()}-${queueItem.customerNumber}`,
            customerId: cust.id,
            customerNumber: cust.customerNumber,
            loanNumber: cust.loanNumber || 1,
            customerName: cust.fullName,
            instalmentNumber: queueItem.instalmentNumber,
            amount: queueItem.amount,
            type: 'payment',
            collector: itemCollector,
            date: getISTDateString(),
            timestamp: getNowTimestamp(),
            notes: `Advance payment recorded via conflict resolution for ${unitLabel} #${queueItem.instalmentNumber}`
          });
        }
      });

      saveData();
      if (typeof syncCustomerToFirestore === 'function') {
        syncCustomerToFirestore(cust);
      }
    }

    // Remove resolved batch from offline queue
    const resolvedIds = new Set(sameCustQueue.map(q => q.offlineTxnId));
    state.offlineSyncQueue = state.offlineSyncQueue.filter(q => !resolvedIds.has(q.offlineTxnId));
  } else if (choice === 'advance') {
    recordTransaction({
      receiptNumber: `ADV-${Date.now()}-${item.customerNumber}`,
      customerId: item.customerId,
      customerNumber: item.customerNumber,
      loanNumber: item.loanNumber || 1,
      customerName: item.customerName,
      instalmentNumber: item.instalmentNumber,
      amount: item.amount,
      type: 'payment',
      collector: collectorName,
      date: getISTDateString(),
      timestamp: getNowTimestamp(),
      notes: `Advance payment recorded via sync conflict resolution for Week #${item.instalmentNumber}`
    });
    saveData();
    state.offlineSyncQueue = state.offlineSyncQueue.filter(q => q.offlineTxnId !== item.offlineTxnId);
  } else {
    // Admin review
    recordTransaction({
      receiptNumber: `REVIEW-${Date.now()}-${item.customerNumber}`,
      customerId: item.customerId,
      customerNumber: item.customerNumber,
      loanNumber: item.loanNumber || 1,
      customerName: item.customerName,
      instalmentNumber: item.instalmentNumber,
      amount: item.amount,
      type: 'payment',
      collector: collectorName,
      date: getISTDateString(),
      timestamp: getNowTimestamp(),
      notes: `FLAGGED FOR ADMIN REVIEW: Original collection for Week #${item.instalmentNumber} already marked settled on cloud.`
    });
    saveData();
    state.offlineSyncQueue = state.offlineSyncQueue.filter(q => q.offlineTxnId !== item.offlineTxnId);
  }

  try {
    localStorage.setItem('jsr_finance_offline_queue', JSON.stringify(state.offlineSyncQueue));
  } catch (e) {}

  _currentConflictItem = null;
  const modal = document.getElementById('sync-conflict-backdrop');
  if (modal) modal.style.display = 'none';
  document.body.classList.remove('modal-open');

  showToast(`✓ Resolved! Collection credited and attributed to ${collectorName}`);
  updateOfflineSyncBadge();
  renderCollectionMatrix();
  if (state.activeTab === 'summary') renderDashboard();
  updateHeaderStats();

  _isSyncingOfflineQueue = false;
  if (state.offlineSyncQueue.length > 0) {
    setTimeout(() => triggerOfflineSync(), 300);
  }
}

// Start application when DOM is ready
window.addEventListener('DOMContentLoaded', initApp);
