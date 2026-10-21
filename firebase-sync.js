/**
 * Google Cloud Firestore Real-Time Database Adapter
 * Loaded via Google CDN - Zero local installations!
 */

let firestoreDb = null;
let isCloudSyncActive = false;

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
    pill.style.background = 'rgba(34, 197, 94, 0.25)';
    pill.style.borderColor = '#22c55e';
    pill.innerHTML = `<span>☁️ Storage:</span> <strong style="color:#4ade80;">Google Cloud (Live)</strong>`;
  } else if (errorMsg) {
    pill.style.background = 'rgba(239, 68, 68, 0.25)';
    pill.style.borderColor = '#ef4444';
    pill.innerHTML = `☁️ Google Cloud: <span style="color:#fca5a5;">Connection Error</span>`;
  } else {
    pill.style.background = 'rgba(255, 255, 255, 0.12)';
    pill.style.borderColor = 'rgba(255, 255, 255, 0.2)';
    pill.innerHTML = `☁️ Storage: <strong style="color:#cbd5e1;">Local Mode</strong>`;
  }
}

// Real-Time Listeners: Sync changes from Google Cloud Firestore
function setupFirestoreRealtimeListeners() {
  if (!firestoreDb) return;

  // 1. Listen to Customers collection in real-time
  firestoreDb.collection('customers').onSnapshot((snapshot) => {
    if (!snapshot.empty) {
      const cloudCustomers = [];
      snapshot.forEach((doc) => {
        cloudCustomers.push(doc.data());
      });
      // Sort by customerNumber numerically
      cloudCustomers.sort((a, b) => Number(a.customerNumber) - Number(b.customerNumber));
      state.customers = cloudCustomers;

      // Update state and UI
      saveDataLocallyOnly();
      updateHeaderStats();
      if (state.activeTab === 'summary') renderDashboard();
      if (state.activeTab === 'collections') renderCollectionMatrix();
      if (state.activeTab === 'customers') renderCustomersTable();
    }
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
  firestoreDb.collection('transactions').limit(500).onSnapshot((snapshot) => {
    if (!snapshot.empty) {
      const cloudTxns = [];
      snapshot.forEach((doc) => {
        cloudTxns.push(doc.data());
      });
      cloudTxns.sort((a, b) => {
        const timeA = a.createdAt || a.timestamp || a.date || '';
        const timeB = b.createdAt || b.timestamp || b.date || '';
        return timeB.localeCompare(timeA);
      });
      state.transactions = cloudTxns;
      try {
        const storageKey = (typeof STORAGE_KEYS !== 'undefined' && STORAGE_KEYS.TRANSACTIONS) ? STORAGE_KEYS.TRANSACTIONS : 'jsr_finance_transactions';
        localStorage.setItem(storageKey, JSON.stringify(cloudTxns));
      } catch (e) {}
      if (typeof renderRecentTransactions === 'function' && state.activeTab === 'summary') {
        renderRecentTransactions();
      }
    }
  }, (err) => {
    console.warn('Firestore transactions listener:', err);
  });
}

// Save customer directly to Google Cloud Firestore
async function syncCustomerToFirestore(customer) {
  if (!firestoreDb || !isCloudSyncActive) return;
  try {
    await firestoreDb.collection('customers').doc(customer.id).set(customer);
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

