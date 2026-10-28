/**
 * Google Cloud Firestore Real-Time Database Adapter
 * Loaded via Google CDN - Zero local installations!
 */

let firestoreDb = null;
let isCloudSyncActive = false;
if (!window.CURRENT_SESSION_ID) {
  window.CURRENT_SESSION_ID = 'SESS-' + Date.now() + '-' + Math.random().toString(36).substring(2, 8);
}
var CURRENT_SESSION_ID = window.CURRENT_SESSION_ID;

// Initialize Google Firebase & Firestore
function initGoogleCloudDatabase() {
  // Check if Firebase keys are in localStorage or firebase-config.js
  let config = null;
  const storedConfig = localStorage.getItem('jsr_firebase_custom_config');

  if (storedConfig) {
    try {
      config = JSON.parse(storedConfig);
    } catch (e) {
      console.warn('Invalid stored Firebase config');
    }
  }

  if (!config && typeof isFirebaseConfigured === 'function' && isFirebaseConfigured()) {
    config = FIREBASE_CONFIG;
  }

  if (config && config.projectId && config.apiKey && typeof firebase !== 'undefined') {
    try {
      if (!firebase.apps.length) {
        firebase.initializeApp(config);
      }
      firestoreDb = firebase.firestore();
      isCloudSyncActive = true;
      updateCloudStatusIndicator(true, config.projectId);
      
      // Ensure Firebase Auth session exists so request.auth != null is satisfied for security rules
      if (firebase.auth) {
        firebase.auth().onAuthStateChanged((user) => {
          if (!user) {
            firebase.auth().signInAnonymously().catch(e => console.warn('Anonymous auth fallback:', e));
          }
        });
      }

      setupFirestoreRealtimeListeners();
      console.log('Successfully connected to Google Cloud Firestore:', config.projectId);
    } catch (err) {
      console.error('Error connecting to Google Cloud Firestore:', err);
      updateCloudStatusIndicator(false, null, err.message);
    }
  } else {
    updateCloudStatusIndicator(false);
  }
}

// Update UI Badge for Cloud Status
function updateCloudStatusIndicator(connected, projectId = '', errorMsg = '') {
  const pill = document.getElementById('cloud-status-pill');
  if (!pill) return;

  if (connected) {
    pill.style.background = 'rgba(34, 197, 94, 0.15)';
    pill.style.borderColor = '#22c55e';
    pill.innerHTML = `<span>☁️ Sync:</span> <strong style="color:#16a34a;">Live ↻</strong>`;
    pill.title = 'Google Cloud Firestore Connected. Click to refresh session data.';
  } else if (errorMsg) {
    pill.style.background = 'rgba(239, 68, 68, 0.15)';
    pill.style.borderColor = '#ef4444';
    pill.innerHTML = `<span>☁️ Sync:</span> <strong style="color:#dc2626;">Error ↻</strong>`;
    pill.title = `Cloud Connection Error: ${errorMsg}. Click to retry.`;
  } else {
    pill.style.background = 'rgba(255, 255, 255, 0.12)';
    pill.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    pill.innerHTML = `<span>☁️ Sync:</span> <strong style="color:#cbd5e1;">Local ↻</strong>`;
    pill.title = 'Working in Local Mode. Click to refresh session.';
  }
}

// Flags to differentiate initial data load from live updates by other users
let isInitialCustomerSnapshot = true;
let isInitialTxnSnapshot = true;

// Real-Time Listeners: Sync changes from Google Cloud Firestore
function setupFirestoreRealtimeListeners() {
  if (!firestoreDb) return;

  // 1. Listen to Customers collection in real-time
  firestoreDb.collection('customers').onSnapshot((snapshot) => {
    const isRemote = !snapshot.metadata.hasPendingWrites;

    // Detect and notify on remote changes from other sessions/users
    if (!isInitialCustomerSnapshot && isRemote && typeof showToast === 'function') {
      snapshot.docChanges().forEach((change) => {
        const c = change.doc.data();
        if (!c) return;
        const loanTag = (Number(c.loanNumber) || 1) > 1 ? ` (Loan #${c.loanNumber})` : '';

        // If this document was updated by our own local session, do NOT notify as an external user update!
        if (c.lastModifiedSession === CURRENT_SESSION_ID) {
          return;
        }

        const modifierName = c.lastModifiedBy || 'another operator';

        if (change.type === 'added') {
          showToast(`✨ Customer #${c.customerNumber}${loanTag} (${c.fullName}) added by ${modifierName}.`);
        } else if (change.type === 'modified') {
          // Reconcile pending local modifications on this customer to prevent collision/stale writes
          if (state.pendingModifications && state.pendingModifications[c.id]) {
            delete state.pendingModifications[c.id];
            showToast(`🔄 Customer #${c.customerNumber}${loanTag} updated by ${modifierName}. Session refreshed with latest ledger.`, 4000);
          } else {
            showToast(`🔄 Customer #${c.customerNumber}${loanTag} updated by ${modifierName}.`);
          }
        } else if (change.type === 'removed') {
          if (state.expandedCustomerIds) state.expandedCustomerIds.delete(c.id);
          if (state.pendingModifications) delete state.pendingModifications[c.id];
          showToast(`🗑️ Customer #${c.customerNumber}${loanTag} deleted by ${modifierName}.`, 4000);
        }
      });
    }
    isInitialCustomerSnapshot = false;

    // Assemble full updated customer list
    const cloudCustomers = [];
    if (!snapshot.empty) {
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (!data) return;
        const isTest = String(data.customerNumber) === '9999' ||
                       (data.fullName && data.fullName.toLowerCase().includes('test automation')) ||
                       doc.id === 'TEST-ISOLATED-AUTOMATION-CUST';
        if (isTest) {
          try {
            doc.ref.delete();
          } catch (e) {}
          return;
        }
        cloudCustomers.push(data);
      });
      // Sort numerically by customerNumber, then loanNumber
      cloudCustomers.sort((a, b) => {
        const numA = Number(a.customerNumber) || 0;
        const numB = Number(b.customerNumber) || 0;
        if (numA !== numB) return numA - numB;
        return (Number(a.loanNumber) || 1) - (Number(b.loanNumber) || 1);
      });
    }
    state.customers = cloudCustomers;

    // Automatically enforce data invariants and self-healing across all customers & loans
    if (typeof healCustomerInvariants === 'function') {
      healCustomerInvariants();
    }

    // Update state and refresh all active screens
    saveDataLocallyOnly();
    updateHeaderStats();
    if (state.activeTab === 'summary') renderDashboard();
    if (state.activeTab === 'collections' || !state.activeTab) renderCollectionMatrix();
    if (state.activeTab === 'customers') renderCustomersTable();
    if (state.activeTab === 'analytics' && typeof renderAnalytics === 'function') renderAnalytics();
    if (state.activeTab === 'settings' && typeof renderSettings === 'function') renderSettings();
  }, (err) => {
    console.error('Firestore customers listener error:', err);
  });

  // 2. Listen to Settings doc
  firestoreDb.collection('config').doc('settings').onSnapshot((doc) => {
    if (doc.exists) {
      state.settings = { ...state.settings, ...doc.data() };
      saveDataLocallyOnly();
      updateHeaderStats();
    }
  });

  // 3. Listen to Transactions collection in real-time (preserves all payments & undos)
  const attachTxnListener = (queryRef) => {
    return queryRef.onSnapshot((snapshot) => {
      const isRemoteTxn = !snapshot.metadata.hasPendingWrites;

      if (!isInitialTxnSnapshot && isRemoteTxn && typeof showToast === 'function') {
        snapshot.docChanges().forEach((change) => {
          if (change.type === 'added') {
            const t = change.doc.data();
            if (!t) return;
            const amtStr = typeof formatMoney === 'function' ? formatMoney(t.amount) : `₹${t.amount}`;
            if (t.type === 'undo') {
              showToast(`↩️ Live Undo: Instalment #${t.instalmentNumber} for #${t.customerNumber} undone remotely.`, 3500);
            } else {
              showToast(`⚡ Live Payment: ${amtStr} received for #${t.customerNumber} (${t.customerName || 'Customer'})`, 3500);
            }
          }
        });
      }
      isInitialTxnSnapshot = false;

      const cloudTxns = [];
      if (!snapshot.empty) {
        snapshot.forEach((doc) => {
          cloudTxns.push(doc.data());
        });
        cloudTxns.sort((a, b) => {
          const timeA = a.createdAt || a.timestamp || a.date || '';
          const timeB = b.createdAt || b.timestamp || b.date || '';
          return timeB.localeCompare(timeA);
        });
      }
      state.transactions = cloudTxns;
      try {
        const storageKey = (typeof STORAGE_KEYS !== 'undefined' && STORAGE_KEYS.TRANSACTIONS) ? STORAGE_KEYS.TRANSACTIONS : 'jsr_finance_transactions';
        localStorage.setItem(storageKey, JSON.stringify(cloudTxns));
      } catch (e) {}

      updateHeaderStats();
      if (typeof renderRecentTransactions === 'function' && state.activeTab === 'summary') {
        renderRecentTransactions();
      }
      if (state.activeTab === 'summary') renderDashboard();
    }, (err) => {
      console.warn('Firestore transactions listener:', err);
    });
  };

  try {
    attachTxnListener(firestoreDb.collection('transactions').orderBy('createdAt', 'desc').limit(500));
  } catch (e) {
    attachTxnListener(firestoreDb.collection('transactions').limit(500));
  }

  // 4. Listen to Editing Locks in real-time (Collaborative edit locks)
  firestoreDb.collection('editing_locks').onSnapshot((snapshot) => {
    const now = Date.now();
    const locks = {};
    if (!snapshot.empty) {
      snapshot.forEach((doc) => {
        const data = doc.data();
        if (data && data.expiresAt && data.expiresAt > now) {
          locks[doc.id] = data;
        }
      });
    }
    state.activeLocks = locks;
    try {
      localStorage.setItem('jsr_finance_editing_locks', JSON.stringify(locks));
    } catch (e) {}

    if (state.activeTab === 'collections') {
      renderCollectionMatrix();
    }
  }, (err) => {
    console.warn('Firestore editing_locks listener:', err);
  });
}

// Global Manual & Automatic Session Refresh Function
async function refreshSessionData(notifyUser = true) {
  if (notifyUser && typeof showToast === 'function') {
    showToast('🔄 Refreshing live session data...');
  }
  const pill = document.getElementById('cloud-status-pill');
  if (pill) {
    pill.style.opacity = '0.6';
  }

  if (firestoreDb && isCloudSyncActive) {
    try {
      const custSnap = await firestoreDb.collection('customers').get();
      const cloudCustomers = [];
      custSnap.forEach(d => {
        const data = d.data();
        if (!data) return;
        const isTest = String(data.customerNumber) === '9999' ||
                       (data.fullName && data.fullName.toLowerCase().includes('test automation')) ||
                       d.id === 'TEST-ISOLATED-AUTOMATION-CUST';
        if (isTest) {
          try { d.ref.delete(); } catch (e) {}
          return;
        }
        cloudCustomers.push(data);
      });
      cloudCustomers.sort((a, b) => {
        const numA = Number(a.customerNumber) || 0;
        const numB = Number(b.customerNumber) || 0;
        if (numA !== numB) return numA - numB;
        return (Number(a.loanNumber) || 1) - (Number(b.loanNumber) || 1);
      });
      state.customers = cloudCustomers;

      const txnSnap = await firestoreDb.collection('transactions').limit(500).get();
      const cloudTxns = [];
      txnSnap.forEach(d => cloudTxns.push(d.data()));
      cloudTxns.sort((a, b) => {
        const timeA = a.createdAt || a.timestamp || a.date || '';
        const timeB = b.createdAt || b.timestamp || b.date || '';
        return timeB.localeCompare(timeA);
      });
      state.transactions = cloudTxns;
    } catch (e) {
      console.warn('Direct cloud refresh failed, falling back to local state', e);
      if (typeof loadData === 'function') loadData();
    }
  } else {
    if (typeof loadData === 'function') loadData();
  }

  if (typeof healCustomerInvariants === 'function') {
    healCustomerInvariants();
  }
  if (typeof saveDataLocallyOnly === 'function') {
    saveDataLocallyOnly();
  }
  updateHeaderStats();
  if (state.activeTab === 'summary') renderDashboard();
  if (state.activeTab === 'collections') renderCollectionMatrix();
  if (state.activeTab === 'customers') renderCustomersTable();
  if (state.activeTab === 'analytics' && typeof renderAnalytics === 'function') renderAnalytics();
  if (state.activeTab === 'settings' && typeof renderSettings === 'function') renderSettings();

  if (pill) {
    pill.style.opacity = '1';
  }
  if (notifyUser && typeof showToast === 'function') {
    showToast('✓ Session refreshed with latest ledger data!');
  }
}

// Cross-Tab / Multi-Window Storage Synchronization (Synchronizes tabs on the same machine)
window.addEventListener('storage', (e) => {
  const custKey = (typeof STORAGE_KEYS !== 'undefined' && STORAGE_KEYS.CUSTOMERS) ? STORAGE_KEYS.CUSTOMERS : 'jsr_finance_customers';
  const txnKey = (typeof STORAGE_KEYS !== 'undefined' && STORAGE_KEYS.TRANSACTIONS) ? STORAGE_KEYS.TRANSACTIONS : 'jsr_finance_transactions';

  if (e.key === custKey) {
    try {
      const updated = JSON.parse(e.newValue);
      if (Array.isArray(updated)) {
        state.customers = updated;
        if (typeof healCustomerInvariants === 'function') healCustomerInvariants();
        updateHeaderStats();
        if (state.activeTab === 'summary') renderDashboard();
        if (state.activeTab === 'collections') renderCollectionMatrix();
        if (state.activeTab === 'customers') renderCustomersTable();
        if (state.activeTab === 'analytics' && typeof renderAnalytics === 'function') renderAnalytics();
        if (typeof showToast === 'function') showToast('🔄 Session synced from another open window.');
      }
    } catch (err) {}
  } else if (e.key === txnKey) {
    try {
      const updatedTxns = JSON.parse(e.newValue);
      if (Array.isArray(updatedTxns)) {
        state.transactions = updatedTxns;
        updateHeaderStats();
        if (state.activeTab === 'summary') {
          renderDashboard();
          if (typeof renderRecentTransactions === 'function') renderRecentTransactions();
        }
      }
    } catch (err) {}
  } else if (e.key === 'jsr_finance_editing_locks') {
    try {
      const updatedLocks = JSON.parse(e.newValue);
      if (updatedLocks && typeof updatedLocks === 'object') {
        state.activeLocks = updatedLocks;
        if (state.activeTab === 'collections') renderCollectionMatrix();
      }
    } catch (err) {}
  }
});

// Save edit lock to Google Cloud Firestore
async function syncEditLockToFirestore(lockData) {
  if (!firestoreDb || !isCloudSyncActive || !lockData || !lockData.customerId) return;
  try {
    await firestoreDb.collection('editing_locks').doc(lockData.customerId).set(lockData);
  } catch (err) {
    console.error('Error saving edit lock to Google Cloud Firestore:', err);
  }
}

// Delete edit lock from Google Cloud Firestore
async function deleteEditLockFromFirestore(customerId) {
  if (!firestoreDb || !isCloudSyncActive || !customerId) return;
  try {
    await firestoreDb.collection('editing_locks').doc(customerId).delete();
  } catch (err) {
    console.error('Error deleting edit lock from Google Cloud Firestore:', err);
  }
}

// Query Firestore to verify or allocate next atomic customer number
async function getNextAtomicCustomerNumber(requestedNumber, customerName) {
  if (!firestoreDb || !isCloudSyncActive) {
    return requestedNumber;
  }
  try {
    const snap = await firestoreDb.collection('customers').get();
    let maxNum = 0;
    const usedByOther = new Set();
    const reqNorm = (customerName || '').trim().toLowerCase();

    snap.forEach((doc) => {
      const data = doc.data();
      if (!data) return;
      const num = Number(data.customerNumber);
      if (!isNaN(num) && num > 0) {
        if (num > maxNum) maxNum = num;
        const existName = (data.fullName || '').trim().toLowerCase();
        // If different name, record as taken by someone else
        if (!reqNorm || existName !== reqNorm) {
          usedByOther.add(num);
        }
      }
    });

    let target = Number(requestedNumber);
    if (isNaN(target) || target <= 0 || usedByOther.has(target)) {
      target = maxNum + 1;
    }
    return target;
  } catch (err) {
    console.warn('Error verifying atomic customer number from Firestore:', err);
    return requestedNumber;
  }
}

// Save customer directly to Google Cloud Firestore
async function syncCustomerToFirestore(customer) {
  if (!firestoreDb || !isCloudSyncActive) return;
  try {
    const currentUser = (typeof getCurrentUser === 'function') ? getCurrentUser() : null;
    const payload = {
      ...customer,
      lastModifiedSession: typeof CURRENT_SESSION_ID !== 'undefined' ? CURRENT_SESSION_ID : null,
      lastModifiedBy: currentUser ? currentUser.user : 'Operator',
      lastModifiedAt: new Date().toISOString()
    };
    await firestoreDb.collection('customers').doc(customer.id).set(payload);
  } catch (err) {
    console.error('Error saving customer to Google Cloud Firestore:', err);
  }
}

// Delete customer from Google Cloud Firestore
async function deleteCustomerFromFirestore(customerId) {
  if (!firestoreDb || !isCloudSyncActive) return;
  try {
    await firestoreDb.collection('customers').doc(customerId).delete();
  } catch (err) {
    console.error('Error deleting from Google Cloud Firestore:', err);
  }
}

// Sync settings to Google Cloud Firestore
async function syncSettingsToFirestore(settings) {
  if (!firestoreDb || !isCloudSyncActive) return;
  try {
    await firestoreDb.collection('config').doc('settings').set(settings);
  } catch (err) {
    console.error('Error saving settings to Google Cloud Firestore:', err);
  }
}

// Sync transaction ledger entry to Google Cloud Firestore
async function syncTransactionToFirestore(txn) {
  if (!firestoreDb || !isCloudSyncActive || !txn || !txn.id) return;
  try {
    await firestoreDb.collection('transactions').doc(txn.id).set(txn);
  } catch (err) {
    console.error('Error saving transaction to Google Cloud Firestore:', err);
  }
}

// Manual Save Custom Firebase Config from Settings UI
function saveFirebaseConfigFromUI(configObj) {
  localStorage.setItem('jsr_firebase_custom_config', JSON.stringify(configObj));
  initGoogleCloudDatabase();
}

function handleSaveCloudCredentials(event) {
  if (event) event.preventDefault();

  const projectId = document.getElementById('gcp-project-id').value.trim();
  const apiKey = document.getElementById('gcp-api-key').value.trim();
  const appId = document.getElementById('gcp-app-id').value.trim();

  if (!projectId || !apiKey) {
    alert('Please enter both Project ID and API Key from your Google Firebase console.');
    return;
  }

  const customConfig = {
    apiKey: apiKey,
    authDomain: `${projectId}.firebaseapp.com`,
    projectId: projectId,
    storageBucket: `${projectId}.appspot.com`,
    messagingSenderId: '',
    appId: appId || ''
  };

  saveFirebaseConfigFromUI(customConfig);
  showToast(`Connecting to Google Cloud: ${projectId}...`);
}

function disconnectCloud() {
  localStorage.removeItem('jsr_firebase_custom_config');
  isCloudSyncActive = false;
  firestoreDb = null;
  updateCloudStatusIndicator(false);
  const pEl = document.getElementById('gcp-project-id');
  if (pEl) pEl.value = '';
  const aEl = document.getElementById('gcp-api-key');
  if (aEl) aEl.value = '';
  const appEl = document.getElementById('gcp-app-id');
  if (appEl) appEl.value = '';
  showToast('Switched to offline local storage.');
}

