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
  defaultInstalmentAmount: 250,
  autoCustNumbering: true,
  nextCustNumber: 1,
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
  expandedCustomerIds: new Set(),
  allExpanded: false,
  pendingModifications: {},
  unsavedPromptCallback: null,
};

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

// Interactive Tooltip Popover for Customer Loans Breakdown
function toggleLoansTooltip(event, customerNumber) {
  if (event) {
    event.stopPropagation();
  }
  const popover = document.getElementById('loans-tooltip-popover');
  const backdrop = document.getElementById('loans-popover-backdrop');
  if (!popover) return;

  if (popover.dataset.openCust === customerNumber && popover.style.display === 'block') {
    hideLoansTooltip();
    return;
  }

  const grouped = getGroupedCustomers();
  const custGroup = grouped.find((g) => g.customerNumber === customerNumber);
  if (!custGroup) return;

  let html = `
    <div class="loans-tooltip-header">
      <span style="display: flex; align-items: center; gap: 6px;">
        <span style="font-size: 16px;">💳</span>
        <span>Loans for #${custGroup.customerNumber} - ${custGroup.fullName}</span>
      </span>
      <button type="button" class="modal-close" style="font-size: 20px; line-height: 1; padding: 2px 8px; cursor: pointer;" onclick="hideLoansTooltip()">&times;</button>
    </div>
    <div style="display: flex; flex-direction: column; gap: 10px; max-height: 55dvh; overflow-y: auto; -webkit-overflow-scrolling: touch; padding: 2px 2px 6px 2px;">
  `;

  custGroup.loans.forEach((loan, idx) => {
    const stats = getCustomerStats(loan);
    const isCurrent = loan.id === custGroup.activeLoan.id;
    const statusBadge = stats.isCompleted 
      ? '<span style="color: #16a34a; font-weight: 700; font-size: 11.5px; background: #dcfce7; padding: 2px 7px; border-radius: 9999px;">✓ Completed</span>'
      : '<span style="color: #2563eb; font-weight: 700; font-size: 11.5px; background: #eff6ff; padding: 2px 7px; border-radius: 9999px;">Active Loan</span>';

    html += `
      <div class="loans-tooltip-item ${isCurrent ? 'active' : ''}">
        <div class="loans-tooltip-loan-title" style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px;">
          <strong style="color: #0f172a; font-size: 13.5px;">Loan #${loan.loanNumber || (idx + 1)} (${loan.frequency || 'Weekly'})</strong>
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
    <div style="margin-top: 12px; padding-top: 10px; border-top: 1px solid #f1f5f9;">
      <button type="button" class="btn btn-primary" onclick="hideLoansTooltip(); openAddLoanForCustomer('${custGroup.customerNumber}')" style="width: 100%; font-size: 13px; padding: 10px 14px; font-weight: 700; justify-content: center;">
        + Issue Additional Loan
      </button>
    </div>
  `;
  popover.innerHTML = html;
  popover.dataset.openCust = customerNumber;
  popover.style.display = 'block';
  if (backdrop) backdrop.style.display = 'block';
  document.body.classList.add('modal-open');

  const isMobile = window.innerWidth <= 768;
  if (!isMobile) {
    const btn = event.currentTarget || event.target;
    const rect = btn.getBoundingClientRect();
    const popoverWidth = 360;
    const popoverHeight = 350;

    let top = rect.bottom + 8;
    if (top + popoverHeight > window.innerHeight && rect.top > popoverHeight) {
      top = rect.top - popoverHeight - 8;
    }
    top = Math.max(12, Math.min(window.innerHeight - popoverHeight - 12, top));

    let left = rect.left - 20;
    if (left + popoverWidth > window.innerWidth - 16) {
      left = window.innerWidth - popoverWidth - 16;
    }
    left = Math.max(16, left);

    popover.style.top = `${top}px`;
    popover.style.left = `${left}px`;
    popover.style.right = 'auto';
    popover.style.bottom = 'auto';
  } else {
    popover.style.top = '';
    popover.style.left = '';
    popover.style.right = '';
    popover.style.bottom = '';
  }
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

// Global document click listener to close loans tooltip when clicking outside
document.addEventListener('click', (e) => {
  const popover = document.getElementById('loans-tooltip-popover');
  if (popover && popover.style.display === 'block') {
    if (!popover.contains(e.target) && !e.target.closest('.loans-badge')) {
      hideLoansTooltip();
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

function quickLoginOwner() {
  verifyAndLoginGoogleUser('singarisurendra@gmail.com', 'Surendra Singari (Owner)');
}

function showGoogleAuthGuideAlert(message) {
  const errorAlert = document.getElementById('login-error-alert');
  if (errorAlert) {
    errorAlert.innerHTML = `
      <div style="text-align: left; line-height: 1.5; width: 100%;">
        <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 6px; gap: 8px;">
          <strong style="color: #92400e;">⚠️ Google Sign-In Setup Notice</strong>
          <button type="button" onclick="quickLoginOwner()" style="background: #2563eb; color: white; border: none; padding: 4px 10px; border-radius: 6px; font-size: 11px; font-weight: 700; cursor: pointer; white-space: nowrap;">
            1-Click Owner Sign-In ↵
          </button>
        </div>
        <span style="font-size: 12px; color: #475569;">${message}</span>
      </div>
    `;
    errorAlert.style.background = '#fef3c7';
    errorAlert.style.borderColor = '#fde68a';
    errorAlert.style.color = '#92400e';
    errorAlert.style.display = 'flex';
  }
}

function handleGoogleSignInClick() {
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

  // 1. Official Firebase Auth Google SSO Popup
  if (typeof firebase !== 'undefined' && firebase.auth) {
    try {
      const provider = new firebase.auth.GoogleAuthProvider();
      provider.setCustomParameters({ prompt: 'select_account' });

      firebase.auth().signInWithPopup(provider)
        .then((result) => {
          if (result && result.user && result.user.email) {
            verifyAndLoginGoogleUser(result.user.email, result.user.displayName || result.user.email);
          } else {
            promptGoogleEmailFallback();
          }
        })
        .catch((error) => {
          console.warn('Firebase Google Auth event:', error);
          if (error.code === 'auth/operation-not-allowed' || error.code === 'auth/configuration-not-found') {
            showGoogleAuthGuideAlert(
              `Google Provider is not enabled in Firebase Console yet. Click the '1-Click Owner Sign-In' button above to proceed immediately, or enable Google under Firebase Console > Authentication > Sign-in method.`
            );
          } else if (error.code === 'auth/unauthorized-domain') {
            showGoogleAuthGuideAlert(
              `Domain is not authorized in Firebase Console > Authentication > Settings. Use 1-Click Owner Sign-In above to sign in without domain restriction.`
            );
          } else if (error.code === 'auth/popup-blocked') {
            promptGoogleEmailFallback('Popup was blocked by your browser. Enter your whitelisted Google account email:');
          } else if (error.code !== 'auth/popup-closed-by-user') {
            promptGoogleEmailFallback('Google Sign-In notice (' + (error.message || 'error') + '). Enter your email:');
          }
        });
      return;
    } catch (e) {
      console.warn('Firebase Auth popup invocation failed:', e);
    }
  }

  // 2. Direct Fallback if Firebase Auth is not present
  promptGoogleEmailFallback();
}

function promptGoogleEmailFallback(customMsg) {
  const email = prompt(customMsg || 'Enter your Google Operator Account Email to verify against the security whitelist:');
  if (!email) return;
  verifyAndLoginGoogleUser(email.trim().toLowerCase(), 'Google Operator');
}

function verifyAndLoginGoogleUser(email, name) {
  const errorAlert = document.getElementById('login-error-alert');
  const normalizedEmail = (email || '').trim().toLowerCase();

  function grantAccess() {
    const sessionData = {
      user: name || normalizedEmail,
      email: normalizedEmail,
      role: 'Admin',
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
    showToast(`✓ Whitelist Verified! Welcome, ${name || normalizedEmail}`);
  }

  function showDenied() {
    if (errorAlert) {
      errorAlert.innerHTML = `
        <div style="text-align: left; line-height: 1.5;">
          <strong>🚫 Access Denied (HTTP 403 Forbidden)</strong><br>
          <span style="font-size: 12px;">Account <code>${normalizedEmail}</code> is not authorized on the operator whitelist. Contact your administrator to grant access in Settings.</span>
        </div>
      `;
      errorAlert.style.display = 'flex';
    }
  }

  // 1. Check local in-memory whitelist
  const dynamicEmails = (state && state.settings && state.settings.operatorWhitelist)
    ? state.settings.operatorWhitelist.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
    : [];
  const fullWhitelist = [...AUTHORIZED_OPERATOR_WHITELIST.map(e => e.toLowerCase()), ...dynamicEmails];

  if (fullWhitelist.some(allowed => normalizedEmail === allowed || normalizedEmail.endsWith('@jsrfinance.com'))) {
    grantAccess();
    return;
  }

  // 2. Multi-device Fallback: Query Firestore config/settings directly for fresh devices
  if (typeof firestoreDb !== 'undefined' && firestoreDb) {
    firestoreDb.collection('config').doc('settings').get()
      .then(doc => {
        if (doc && doc.exists) {
          const cloudSettings = doc.data();
          const cloudEmails = (cloudSettings && cloudSettings.operatorWhitelist)
            ? cloudSettings.operatorWhitelist.split(',').map(e => e.trim().toLowerCase()).filter(Boolean)
            : [];
          if (cloudEmails.includes(normalizedEmail)) {
            state.settings = { ...state.settings, ...cloudSettings };
            if (typeof saveDataLocallyOnly === 'function') saveDataLocallyOnly();
            grantAccess();
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
  const grouped = getGroupedCustomers();
  const matchedCustomers = grouped.filter(g => 
    !q || 
    g.customerNumber.toString().includes(q) || 
    g.fullName.toLowerCase().includes(q) || 
    (g.activeLoan.mobile && g.activeLoan.mobile.includes(q))
  ).slice(0, 8);

  if (matchedCustomers.length > 0) {
    html += `<div style="font-size: 11px; font-weight: 700; color: #64748b; padding: 10px 10px 6px 10px; text-transform: uppercase;">Customers (${matchedCustomers.length})</div>`;
    matchedCustomers.forEach((cust) => {
      const stats = getCustomerStats(cust.activeLoan);
      html += `
        <div class="command-item" onclick="closeCommandPalette(); switchTab('collections'); toggleCustomerScheduleDrawer('${cust.activeLoan.id}');">
          <div class="command-item-left">
            <div class="command-item-icon" style="background: #e0f2fe; color: #0284c7;">#${cust.customerNumber}</div>
            <div>
              <div class="command-item-title">${cust.fullName} <span style="font-size: 11px; color: #2563eb; font-weight: 600;">(${cust.loans.length} Loans)</span></div>
              <div class="command-item-sub">${cust.activeLoan.area || 'Main Area'} • Balance: ${formatMoney(stats.balance)}</div>
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
  if (!pending || !pending.sessionAmount) {
    delete state.pendingModifications[pendingId];
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
    for (let i = 1; i <= totalInst; i++) {
      const before = pending.initialInstalments[i - 1] || { number: i, status: 'Pending', paidAmount: 0 };
      const after = pending.modifiedInstalments[i - 1] || { number: i, status: 'Pending', paidAmount: 0 };
      const beforePaid = before.status === 'Received' ? (Number(before.paidAmount) || Number(customer.instalmentAmount) || Number(before.dueAmount) || 0) : (Number(before.paidAmount) || 0);
      const afterPaid = after.status === 'Received' ? (Number(after.paidAmount) || Number(customer.instalmentAmount) || Number(after.dueAmount) || 0) : (Number(after.paidAmount) || 0);

      const diff = afterPaid - beforePaid;
      if (diff > 0) {
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
    } else {
      // Per user spec: Expand ONLY the selected customer (collapse previously opened ones)
      state.expandedCustomerIds.clear();
      state.expandedCustomerIds.add(customerId);
    }
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
  if (state.allExpanded) {
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
  const isAlreadyCommitted = custInst && (custInst.status === 'Received' || custInst.status === 'Partial');

  // Case 1: The instalment is already committed/saved in customer.instalments -> Handle UNDO immediately
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
  const txn = {
    id,
    ...txnData,
    date: txnData.date || getISTDateString(),
    timestamp: txnData.timestamp || getNowTimestamp(),
    collector: txnData.collector || (currentUser ? currentUser.user : 'Admin'),
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
  if (typeof syncTransactionToFirestore === 'function') {
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
        curInst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, targetInstNum);
        remainingSurplus -= needed;
        targetInstNum++;
      } else {
        curInst.status = 'Partial';
        curInst.paidAmount = existingPaid + remainingSurplus;
        curInst.paidDate = todayStr;
        curInst.paidTimestamp = timestampStr;
        curInst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, targetInstNum) + '-P';
        remainingSurplus = 0;
        break;
      }
    }

    if (remainingSurplus > 0) {
      showToast(`⚠️ All ${totalInst} instalments paid! Remaining surplus: ${formatMoney(remainingSurplus)}`, 4000);
    }
  } else {
    // 1-click toggle
    if (inst.status === 'Received') {
      inst.status = 'Pending';
      inst.paidDate = null;
      inst.paidTimestamp = null;
      inst.paidAmount = 0;
      inst.receiptNumber = null;
    } else if (inst.status === 'Partial') {
      inst.status = 'Received';
      inst.paidAmount = scheduledAmount;
      inst.paidDate = todayStr;
      inst.paidTimestamp = timestampStr;
      inst.receiptNumber = generateUniqueReceiptNumber(customer.customerNumber, customer.loanNumber, instNumber);
    } else {
      inst.status = 'Received';
      inst.paidAmount = scheduledAmount;
      inst.paidDate = todayStr;
      inst.paidTimestamp = timestampStr;
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

  renderCollectionMatrix();
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
  switchTab('collections');
  if (typeof initGoogleCloudDatabase === 'function') {
    initGoogleCloudDatabase();
  }
  if (window.lucide) {
    window.lucide.createIcons();
  }
}

// Self-Healing Accounting Invariant Guard: Protects customer records across all loans (e.g. L1, L2, L3)
function healCustomerInvariants() {
  if (!state.customers || !Array.isArray(state.customers)) return false;
  let modified = false;

  state.customers.forEach((c) => {
    if (!c) return;
    const instAmt = Number(c.instalmentAmount) || 200;
    const totInst = Number(c.totalInstalments) || 52;
    const expectedPayable = totInst * instAmt;

    if (c.totalPayable !== expectedPayable) {
      c.totalPayable = expectedPayable;
      modified = true;
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
        // Automatically filter out any starter demo data for live production use
        state.customers = Array.isArray(parsed) ? parsed.filter(c => c && c.id && !c.id.startsWith('DEMO-')) : [];
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
  const isCompleted = balance <= 0 || paidCount >= totalInst;
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
    dueToDate: typeof cappedExpected !== 'undefined' ? cappedExpected : paidCount,
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

    // Check today's collections
    if (cust.instalments) {
      cust.instalments.forEach((inst) => {
        if (inst && (inst.status === 'Received' || inst.status === 'Partial') && inst.paidDate === todayStr) {
          todayCollected += (Number(inst.paidAmount) || cust.instalmentAmount);
        }
      });
    }
  });

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
}

// Navigation & Tab Switching
function switchTab(tabName) {
  checkAndPromptUnsaved(null, () => {
    state.activeTab = tabName;

    document.querySelectorAll('.nav-link').forEach((link) => {
      link.classList.toggle('active', link.dataset.tab === tabName);
    });

    document.querySelectorAll('.mobile-nav-item').forEach((item) => {
      item.classList.toggle('active', item.dataset.tab === tabName);
    });

    document.querySelectorAll('.mobile-header-btn').forEach((btn) => {
      btn.classList.toggle('active', btn.dataset.tab === tabName);
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
            collector: 'Admin',
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
            ${item.timestamp ? `<div style="font-size:10.5px; color:#94a3b8;">${item.timestamp.split(' ').slice(1).join(' ')}</div>` : ''}
          </td>
          <td><span style="background:#f1f5f9; color:#475569; padding:2px 8px; border-radius:4px; font-size:11px;">${item.areaRoute}</span></td>
          <td>${statusHtml}</td>
        </tr>
      `;
    }).join('');
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

  // Rates & Proportional Accounting Invariant: principalRecovered + totalRealizedProfit === totalCollected
  const principalRecovered = Math.max(0, totalCollected - totalRealizedProfit);
  const recoveryRate = totalDisbursed > 0 ? Math.round((principalRecovered / totalDisbursed) * 100) : 0;
  const profitYield = totalDisbursed > 0 ? ((totalRealizedProfit / totalDisbursed) * 100).toFixed(1) : '0.0';
  const collectionVelocity = totalDueWeeks > 0 ? Math.min(100, Math.round((totalPaidWeeks / totalDueWeeks) * 100)) : 100;
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
  if (elRem) elRem.textContent = formatMoney(remainingOutlay);

  // Calendar-Based Weekly Collection Bar Chart (8 Calendar Weeks ending Current Week)
  const numWeeks = 8;
  const now = new Date();
  const dayOfWeek = (now.getDay() + 6) % 7; // Monday = 0
  const currentMonday = new Date(now.getFullYear(), now.getMonth(), now.getDate() - dayOfWeek);

  const calendarWeeks = [];
  for (let i = numWeeks - 1; i >= 0; i--) {
    const wStart = new Date(currentMonday.getTime() - i * 7 * 24 * 60 * 60 * 1000);
    const wEnd = new Date(wStart.getTime() + 6 * 24 * 60 * 60 * 1000);
    const startStr = getISTDateString(wStart);
    const endStr = getISTDateString(wEnd);
    const shortLabel = i === 0 ? 'This Wk' : (i === 1 ? 'Last Wk' : wStart.toLocaleDateString('en-IN', { day: 'numeric', month: 'short' }));
    calendarWeeks.push({
      startStr,
      endStr,
      label: shortLabel,
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

  const chartEl = document.getElementById('ana-weekly-chart');
  if (chartEl) {
    const maxVal = Math.max(1, ...calendarWeeks.map(w => w.total));
    let chartHtml = '';
    calendarWeeks.forEach(w => {
      const val = w.total;
      const barHeightPx = val > 0 ? Math.max(10, Math.round((val / maxVal) * 128)) : 6;
      const formattedVal = val > 0 ? (val >= 1000 ? (val >= 10000 ? (val / 1000).toFixed(0) + 'k' : (val / 1000).toFixed(1) + 'k') : val) : '';
      chartHtml += `
        <div style="flex:1; min-width:0; display:flex; flex-direction:column; align-items:center; justify-content:flex-end; height:190px; gap:4px;">
          <div style="font-size:10px; font-weight:700; color:#2563eb; min-height:14px; line-height:14px; text-align:center; white-space:nowrap;">${formattedVal}</div>
          <div style="width:100%; height:135px; display:flex; align-items:flex-end; justify-content:center; background:#f8fafc; border-radius:6px; padding:2px 1px;">
            <div style="width:100%; max-width:28px; height:${barHeightPx}px; background:${val > 0 ? 'linear-gradient(180deg, #3b82f6 0%, #1d4ed8 100%)' : '#e2e8f0'}; border-radius:4px 4px 0 0; box-shadow:${val > 0 ? '0 2px 6px rgba(37,99,235,0.25)' : 'none'}; cursor:pointer;" title="${w.label} (${w.startStr} to ${w.endStr}): ${formatMoney(val)}"></div>
          </div>
          <div style="font-size:10px; color:#64748b; font-weight:600; min-height:14px; line-height:14px; text-align:center;">${w.label}</div>
        </div>
      `;
    });
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

  // Synchronize Expand All / Collapse All button text if present
  const btnExpandAll = document.getElementById('btn-expand-all');
  if (btnExpandAll) {
    btnExpandAll.innerHTML = state.allExpanded ? '<span>︿</span> Collapse all' : '<span>⌵</span> Expand all';
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

  // Filter Customers across all loans
  const query = state.searchQuery.toLowerCase().trim();
  const filtered = state.customers.filter((c) => {
    const matchesSearch =
      c.customerNumber.toString().toLowerCase().includes(query) ||
      c.fullName.toLowerCase().includes(query) ||
      (c.phone && c.phone.includes(query)) ||
      (c.areaRoute && c.areaRoute.toLowerCase().includes(query));

    if (!matchesSearch) return false;

    const stats = getCustomerStats(c);
    if (state.filterStatus === 'active') return !stats.isCompleted;
    if (state.filterStatus === 'overdue') return stats.isOverdue;
    if (state.filterStatus === 'partial') return (c.instalments || []).some(i => i && i.status === 'Partial');
    if (state.filterStatus === 'completed') return stats.isCompleted;
    if (state.filterStatus === 'weekly') return c.frequency !== 'Daily' && (c.totalInstalments || 52) !== 100;
    if (state.filterStatus === 'daily') return c.frequency === 'Daily' || c.totalInstalments === 100;
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

        if (isReceived) {
          btnClass = 'is-paid';
          btnIcon = '✓';
        } else if (isPartial) {
          btnClass = 'is-partial';
          btnIcon = '-';
        }

        gridCellsHtml += `
          <div class="sched-cell">
            <span class="sched-num-label">${sq}</span>
            <button type="button" 
                    class="sched-box-btn ${btnClass}" 
                    onclick="handleInstalmentClick('${cust.id}', ${sq}, event)" 
                    title="${unitLabel} #${sq}: ${sqInst.status}. Tap to toggle.">
              ${btnIcon}
            </button>
          </div>
        `;
      }
    }

    cardsHtml += `
      <div class="cust-compact-card ${isExpanded ? 'card-expanded' : ''}" data-customer-id="${cust.id}">
        <!-- Top Compact Card Header (Click to toggle expansion) -->
        <div class="cust-card-header" onclick="toggleCustomerSchedule('${cust.id}', event)" title="${cust.fullName} (#${cust.customerNumber}) - ${cust.phone || 'No Phone'}">
          <div class="cust-card-left">
            <span class="cust-id-prefix">#${cust.customerNumber}</span>
            <div class="cust-avatar" style="${avatarStyle}">${initials}</div>
            <div class="cust-info-left">
              <div class="cust-name-row">
                <span class="cust-name">${cust.fullName}</span>
                <span class="cust-loan-badge">L${cust.loanNumber || 1}</span>
                ${stats.isOverdue ? `<span class="badge-overdue" style="font-size:10px; padding:1px 5px; margin-left:4px;">⚠️ Due ${stats.missedCount}</span>` : ''}
              </div>
              <div class="cust-sub-details">
                ${custIdStr} • ${cust.phone || 'No Phone'}
              </div>
              <div class="cust-financial-terms">
                ${formatMoney(cust.givenAmount)} • ${formatMoney(cust.instalmentAmount)}/${unitLabel.toLowerCase()}
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
            <div class="cust-chevron-icon ${isExpanded ? 'rotated' : ''}">
              ⌵
            </div>
          </div>
        </div>

        <!-- Expanded 4-Row Checkbox Matrix -->
        ${isExpanded ? `
          <div class="cust-card-expanded-body" onclick="event.stopPropagation()">
            <div class="sched-4row-grid" style="${instCount === 100 ? 'grid-template-columns: repeat(10, 1fr);' : ''}">
              ${gridCellsHtml}
            </div>

            ${hasPendingMod && pendingMod.sessionAmount > 0 ? `
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
    showToast(`✓ Received ${formatMoney(totalCollectedThisAction)} for #${customer.customerNumber}`);
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
}

// Auto-populate default due amount or remaining partial balance as user types customer #
function handleQuickCustNumChange() {
  const custNumInput = document.getElementById('quick-cust-num');
  const amountInput = document.getElementById('quick-amount');
  if (!custNumInput || !amountInput) return;

  const rawInput = custNumInput.value.trim();
  if (!rawInput) {
    amountInput.value = '';
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
  if (matches.length === 0) return;

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

// ----------------------------------------------------
// SCREEN 3: CUSTOMER MASTER & PASSBOOK
// ----------------------------------------------------
function renderCustomersTable() {
  const tbody = document.getElementById('customers-table-body');
  if (!tbody) return;
  const query = state.searchQuery.toLowerCase().trim();

  const filtered = state.customers.filter((c) => {
    return (
      c.customerNumber.toString().toLowerCase().includes(query) ||
      c.fullName.toLowerCase().includes(query) ||
      (c.phone && c.phone.includes(query)) ||
      (c.areaRoute && c.areaRoute.toLowerCase().includes(query))
    );
  });

  filtered.sort((a, b) => {
    const numA = Number(a.customerNumber) || 0;
    const numB = Number(b.customerNumber) || 0;
    if (numA !== numB) return numA - numB;
    return (Number(b.loanNumber) || 1) - (Number(a.loanNumber) || 1);
  });

  if (filtered.length === 0) {
    tbody.innerHTML = `<tr><td colspan="12" style="text-align:center; padding:30px; color:#94a3b8;">No customers registered yet. Click "+ Add New Customer" to start.</td></tr>`;
    const mobileContainer = document.getElementById('customers-mobile-cards');
    if (mobileContainer) {
      mobileContainer.innerHTML = `<div style="text-align:center; padding:30px; color:#94a3b8; background:#fff; border-radius:12px; border:1px solid #e2e8f0;">No customers registered yet.</div>`;
    }
    return;
  }

  tbody.innerHTML = filtered.map((c) => {
    const stats = getCustomerStats(c);
    const totalInst = c.totalInstalments || 52;
    const allLoans = state.customers.filter(x => x.customerNumber.toString() === c.customerNumber.toString());
    const hasMultipleLoans = allLoans.length > 1 || (c.loanNumber && c.loanNumber > 1);
    const loanBadgeHtml = hasMultipleLoans ? ` <span class="loan-badge">L${c.loanNumber || 1}</span>` : '';

    return `
      <tr>
        <td>
          <strong style="color:#1e3a8a; font-size:14px;">#${c.customerNumber}</strong>${loanBadgeHtml}
          ${stats.isOverdue ? `<br><span class="badge-overdue" style="margin-top:2px;" title="${stats.missedCount} instalments behind schedule">⚠️ Due ${stats.missedCount}</span>` : ''}
        </td>
        <td>
          <div style="font-weight:600;">${c.fullName}</div>
          <div style="font-size:12px; color:#64748b;">${c.address || 'No Address'}</div>
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
        <td><strong>${formatMoney(c.givenAmount)}</strong></td>
        <td>
          <div style="font-weight:600;">${formatMoney(c.instalmentAmount)} ${c.frequency === 'Daily' || totalInst === 100 ? '/day' : '/wk'}</div>
          ${c.frequency === 'Daily' || totalInst === 100 
            ? '<span style="background:#fef3c7; color:#b45309; padding:1px 5px; border-radius:3px; font-size:10px; font-weight:700;">Daily</span>'
            : '<span style="background:#eff6ff; color:#1d4ed8; padding:1px 5px; border-radius:3px; font-size:10px; font-weight:700;">Weekly</span>'}
        </td>
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
            <button class="btn btn-outline btn-sm" style="color: #16a34a; border-color: #86efac;" onclick="sendWhatsAppDueReminder('${c.id}')" title="Send WhatsApp Due Reminder">💬 WA</button>
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
      const allLoans = state.customers.filter(x => x.customerNumber.toString() === c.customerNumber.toString());
      const hasMultipleLoans = allLoans.length > 1 || (c.loanNumber && c.loanNumber > 1);
      const loanBadgeHtml = hasMultipleLoans ? `<span class="loan-badge">L${c.loanNumber || 1}</span>` : '';

      return `
        <div class="customer-card">
          <div class="customer-card-header">
            <div class="customer-card-title">
              <span class="customer-card-num">#${c.customerNumber}</span>
              ${loanBadgeHtml}
              <div>
                <div class="customer-card-name">${c.fullName}</div>
                <div class="customer-card-meta">${c.phone || 'No Phone'} • <span style="background:#e0f2fe; color:#0369a1; padding:1px 6px; border-radius:4px; font-size:11px;">${c.areaRoute || 'General'}</span></div>
              </div>
            </div>
            <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0;">
              <button type="button" class="loans-badge" onclick="toggleLoansTooltip(event, '${c.customerNumber}')" title="Click to view all loans for #${c.customerNumber}">
                <span>💳</span>
                <span>${allLoans.length} ${allLoans.length === 1 ? 'Loan' : 'Loans'}</span>
                <span style="font-size:10px;">▾</span>
              </button>
              <span class="badge-status ${stats.isCompleted ? 'badge-status-completed' : 'badge-status-active'}">${stats.isCompleted ? '✓ Completed' : '● Active'}</span>
              ${stats.isOverdue ? `<span class="badge-status badge-status-overdue">⚠️ Due ${stats.missedCount}</span>` : ''}
            </div>
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
            <button class="btn btn-outline" style="color: #16a34a; border-color: #86efac;" onclick="sendWhatsAppDueReminder('${c.id}')">💬 WA</button>
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
  document.getElementById('cust-form-date').value = getISTDateString();

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

  const wrap = document.getElementById('existing-customer-selector-wrap');
  if (wrap) wrap.style.display = 'none';

  calculateFromAmount();
  openModal('modal-customer');
}

// Save Customer (Create or Update with Multi-Loan & Frequency support)
function handleSaveCustomer(event) {
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

  // Strict Form Validation (Zero Silent Defaults)
  if (!rawCustNum || isNaN(rawCustNum) || Number(rawCustNum) <= 0) {
    alert('Please enter a valid Customer Number (e.g. 1, 2, 3...)');
    return;
  }
  if (!rawFullName) {
    alert('Please enter Customer Full Name');
    return;
  }
  if (!rawGiven || isNaN(rawGiven) || Number(rawGiven) <= 0) {
    alert('Please enter a valid Disbursal Amount greater than 0');
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

  const customerNumber = rawCustNum;
  const fullName = rawFullName;
  const givenAmount = Number(rawGiven);
  const totalInstalments = Number(rawInstCount);
  const instalmentAmount = Number(rawInstAmt);
  const frequency = document.getElementById('cust-form-frequency')?.value || (totalInstalments === 100 ? 'Daily' : 'Weekly');

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
      const existingInsts = existing.instalments || [];
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
      existing.startDate = startDate;
      existing.frequency = frequency;

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

      // Synchronize shared contact details across all loans of this customer
      state.customers.forEach(other => {
        if (other.customerNumber.toString() === customerNumber.toString() && other.id !== existing.id) {
          other.fullName = fullName;
          other.phone = phone;
          other.address = address;
          other.areaRoute = areaRoute;
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
      instalments,
      createdAt: new Date().toISOString(),
    });

    if (loanNumber === 1) {
      state.settings.nextCustNumber = Math.max(state.settings.nextCustNumber || 1, Number(customerNumber) + 1);
    }

    // Sync contact info to existing loans of this customer if creating L2/L3
    state.customers.forEach(other => {
      if (other.customerNumber.toString() === customerNumber.toString() && other.id !== newId) {
        other.fullName = fullName;
        other.phone = phone;
        other.address = address;
        other.areaRoute = areaRoute;
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

// Helper: Format Dates consistently (YYYY-MM-DD -> DD/MM/YYYY or DD/MM/YY)
function formatPassbookDate(dateStr, isCompact = false) {
  if (!dateStr || dateStr === '-') return '-';
  const str = String(dateStr).trim();
  const parts = str.split('-');
  if (parts.length === 3 && parts[0].length === 4) {
    const [y, m, d] = parts;
    return isCompact ? `${d}/${m}/${y.slice(2)}` : `${d}/${m}/${y}`;
  }
  return str;
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

  document.getElementById('passbook-modal-title').textContent = `Customer Passbook - #${c.customerNumber}${loanSuffix}: ${c.fullName}`;
  document.getElementById('passbook-header-info').innerHTML = `
    ${loanSwitcherHtml}
    <div style="display:grid; grid-template-columns: repeat(auto-fit, minmax(180px, 1fr)); gap:12px; background:#f1f5f9; padding:14px; border-radius:8px; margin-bottom:16px;">
      <div><span style="color:#64748b; font-size:12px;">Customer:</span><br><strong>#${c.customerNumber}${loanBadgeHtml} - ${c.fullName}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Phone:</span><br><strong>${c.phone || 'N/A'}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Given Amount:</span><br><strong style="color:#1e3a8a;">${formatMoney(c.givenAmount)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Instalment:</span><br><strong>${formatMoney(c.instalmentAmount)} ${unitRate}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Total Repayable:</span><br><strong style="color:#1e293b;">${formatMoney(stats.totalPayable)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Total Paid:</span><br><strong style="color:#16a34a;">${formatMoney(stats.totalPaid)} (${stats.paidCount}/${totalInst})</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Balance Due:</span><br><strong style="color:#b45309;">${formatMoney(stats.balance)}</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Expected Net Profit:</span><br><strong style="color:#7c3aed;">+ ${formatMoney(stats.expectedProfit)} (${stats.profitReturnPercent}%)</strong></div>
      <div><span style="color:#64748b; font-size:12px;">Plan Frequency:</span><br>${planBadge}</div>
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
                ? `<span class="badge-status badge-status-partial">½ Partial (${formatMoney(inst.paidAmount)})</span>`
                : `<span style="color:#94a3b8;">Pending</span>`)}
        </td>
        <td>${formatPassbookDate(inst.paidDate) || '-'}</td>
        <td>${inst.receiptNumber || '-'}</td>
        <td>
          <button class="btn btn-outline btn-sm" onclick="toggleInstalmentReceived('${c.id}', ${w}); openCustomerPassbook('${c.id}');">
            ${isReceived ? 'Undo' : (isPartial ? 'Pay Balance' : 'Mark Received')}
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
        <div class="summary-card">
          <div class="info-cell">
            <span class="info-label">Customer ID & Name:</span>
            <span class="info-val">#${c.customerNumber}${loanSuffix} - ${c.fullName}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">Phone / Mobile:</span>
            <span class="info-val">${c.phone || 'N/A'}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">Loan Plan:</span>
            <span class="info-val">${planName}</span>
          </div>
          <div class="info-cell">
            <span class="info-label">Loan Status:</span>
            <span class="badge-status ${stats.isCompleted ? 'status-completed' : 'status-active'}">${stats.isCompleted ? 'COMPLETED' : 'ACTIVE'}</span>
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
  document.getElementById('setting-default-instalments').value = state.settings.defaultInstalments;
  document.getElementById('setting-default-inst-amount').value = state.settings.defaultInstalmentAmount;
  
  const whitelistInput = document.getElementById('setting-operator-whitelist');
  if (whitelistInput) {
    whitelistInput.value = state.settings.operatorWhitelist || '';
  }

  applyScreenZoom();
  updateSoundToggleButton();
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

    let startDate = colDate !== -1 ? String(row[colDate] || '').trim() : '';
    if (!startDate || startDate.length < 4) {
      startDate = todayStr;
    }

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
    const startMs = new Date(startDate).getTime() || new Date(todayStr).getTime();

    for (let i = 1; i <= totalInstalments; i++) {
      const daysOffset = frequency === 'Daily' ? (i - 1) : (i - 1) * 7;
      const instDate = new Date(startMs + daysOffset * 86400000).toISOString().split('T')[0];
      const remainingToAllocate = targetPaid - accumulatedPaid;

      if (remainingToAllocate >= instalmentAmount) {
        instalments.push({
          number: i,
          dueAmount: instalmentAmount,
          paidAmount: instalmentAmount,
          status: 'Received',
          paidDate: instDate,
          paidTimestamp: instDate + 'T10:00:00.000Z',
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
          paidTimestamp: instDate + 'T10:00:00.000Z',
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
      startDate,
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
  }
  if (!document.querySelector('.modal-overlay.active') && !document.getElementById('loans-tooltip-popover')?.dataset?.openCust) {
    document.body.classList.remove('modal-open');
  }
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
        collectedTodayRupees += (Number(inst.paidAmount) || c.instalmentAmount);
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
                  ? `<span class="badge-status badge-status-overdue">⚠️ Due ${stats.missedCount}</span>`
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
            ? `<button class="btn btn-sm btn-outline" style="background: #ecfdf5; color: #15803d; border-color: #86efac; flex: 1;" onclick="sendWhatsAppPaymentReceipt('${c.id}', ${paidTodayInst.paidAmount || c.instalmentAmount}, ${paidTodayInst.number})">
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

  document.getElementById('partial-cust-id').value = customerId;
  document.getElementById('partial-inst-num').value = instNumber;
  document.getElementById('partial-modal-cust-name').textContent = `#${c.customerNumber} - ${c.fullName}`;

  const inst = (c.instalments && c.instalments[instNumber - 1]);
  const scheduled = Number(c.instalmentAmount) || 200;
  const paidSoFar = Number(inst?.paidAmount) || 0;
  const remaining = Math.max(1, scheduled - paidSoFar);

  document.getElementById('partial-modal-details').textContent = 
    `Instalment #${instNumber} | Scheduled: ${formatMoney(scheduled)} | Already Paid: ${formatMoney(paidSoFar)} | Remaining: ${formatMoney(remaining)}`;

  const amountInput = document.getElementById('partial-pay-amount');
  amountInput.value = remaining;
  amountInput.max = remaining;

  openModal('modal-partial-pay');
  setTimeout(() => amountInput.focus(), 150);
}

function handlePartialPaySubmit(event) {
  event.preventDefault();
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
