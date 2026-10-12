/**
 * Google Cloud / Firebase Configuration for JSR Finance
 * 
 * Instructions to connect your Google Cloud / Firebase Database:
 * 1. Go to https://console.firebase.google.com
 * 2. Click "Add project" (Name: jsr-finance)
 * 3. In the sidebar, click: Build -> Firestore Database -> Click "Create database" (Start in Test mode)
 * 4. In Project Overview (Gear icon ⚙️) -> Project Settings:
 *    - Under "Your apps", click the Web icon (</>)
 *    - Register app: "JSR Finance Web"
 *    - Copy the `firebaseConfig` object and paste it below:
 */

const FIREBASE_CONFIG = {
  apiKey: "AIzaSyDAk2lMErXlWdjxdoY3Mdp9bgzPf7XHowk",
  authDomain: "jsr-finance-app-4a72e.firebaseapp.com",
  projectId: "jsr-finance-app-4a72e",
  storageBucket: "jsr-finance-app-4a72e.firebasestorage.app",
  messagingSenderId: "804448045954",
  appId: "1:804448045954:web:d95cd7336237762b0b5d9b",
  measurementId: "G-FR61Y5RXED"
};

// Check if user has entered their real Google Firebase credentials
function isFirebaseConfigured() {
  return FIREBASE_CONFIG && 
         FIREBASE_CONFIG.projectId && 
         FIREBASE_CONFIG.projectId !== "YOUR_PROJECT_ID" &&
         FIREBASE_CONFIG.apiKey !== "YOUR_API_KEY";
}
