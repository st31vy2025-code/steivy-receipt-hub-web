<script type="module">
  // Import the functions you need from the SDKs you need
  import { initializeApp } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-app.js";
  import { getAnalytics } from "https://www.gstatic.com/firebasejs/13.1.0/firebase-analytics.js";
  // TODO: Add SDKs for Firebase products that you want to use
  // https://firebase.google.com/docs/web/setup#available-libraries

  // Your web app's Firebase configuration
  // For Firebase JS SDK v7.20.0 and later, measurementId is optional
  const firebaseConfig = {
    apiKey: "AIzaSyDjkmsFPtZQmIFap84F1Wd3xXaCqvHhURI",
    authDomain: "steivy-receipt-hub.firebaseapp.com",
    projectId: "steivy-receipt-hub",
    storageBucket: "steivy-receipt-hub.firebasestorage.app",
    messagingSenderId: "49993143532",
    appId: "1:49993143532:web:9f86b5f689c7400815c1c9",
    measurementId: "G-WQQ07J61XB"
  };

  // Initialize Firebase
  const app = initializeApp(firebaseConfig);
  const analytics = getAnalytics(app);
</script>