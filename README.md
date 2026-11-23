<div align="center">

<img src="public/icon-192.png" width="80" alt="OrderNearMe Logo" />

# OrderNearMe

**Pool grocery delivery fees with people near you — split the cost, not the convenience.**

[![Live Demo](https://img.shields.io/badge/Live%20Demo-ordernearme--8e448.web.app-blue?style=for-the-badge&logo=firebase)](https://ordernearme-8e448.web.app)
[![Firebase](https://img.shields.io/badge/Firebase-Firestore%20%2B%20Auth-orange?style=for-the-badge&logo=firebase)](https://firebase.google.com)
[![React](https://img.shields.io/badge/React-18-61DAFB?style=for-the-badge&logo=react)](https://react.dev)
[![Vite](https://img.shields.io/badge/Vite-5-646CFF?style=for-the-badge&logo=vite)](https://vitejs.dev)
[![License: MIT](https://img.shields.io/badge/License-MIT-green?style=for-the-badge)](LICENSE)

</div>

---

## 🚀 What is OrderNearMe?

OrderNearMe is a **real-time collaborative ordering platform** for campus hostels, PGs, and apartments. It lets people within **150 metres** of each other discover, join, and pool grocery delivery orders from Blinkit, Instamart, and Zepto — sharing the delivery fee instead of paying it individually.

> **Built for students & hostel residents** who order from the same apps, at the same time, from the same location — but pay separate delivery fees. ONM fixes that.

---

## ✨ Features

| Feature | Description |
|---|---|
| 🔐 **Google Sign-In** | One account, one identity — no fake profiles |
| 📍 **GPS Proximity Filter** | See only orders placed within 150m of your location |
| 🛒 **Post an Order** | Create a group for Blinkit / Instamart / Zepto |
| 🤝 **Join & Pool** | Join existing nearby orders and split the delivery fee |
| 💬 **Real-time Group Chat** | Coordinate with your group before checkout |
| ⏱️ **Auto-expiry** | Groups auto-close after 60 minutes |
| 📋 **Profile & History** | View your past groups and orders anytime |
| 🧾 **Bill Reconciliation** | Automated fair-share delivery fee calculator |
| 📱 **PWA Ready** | Installable on Android & iOS |

---

## 🏗️ Tech Stack

```
Frontend     →  React 18 + Vite 5
Auth         →  Firebase Authentication (Google OAuth)
Database     →  Cloud Firestore (real-time listeners)
Hosting      →  Firebase Hosting
PWA          →  Custom Service Worker + Web App Manifest
Testing      →  Node.js built-in test runner (28 tests)
```

---

## 📂 Project Structure

```
ordernearme/
├── public/
│   ├── icon-192.png          # PWA icons
│   ├── icon-512.png
│   ├── manifest.json         # PWA manifest
│   └── sw.js                 # Service Worker
├── src/
│   ├── App.jsx               # Main app — auth, UI, real-time logic
│   ├── firebase.js           # Firebase config
│   ├── main.jsx              # Entry point
│   ├── constants/
│   │   └── orderLifecycle.js # Order state machine constants
│   └── services/
│       ├── orderService.js   # Create / update / expire orders
│       ├── groupService.js   # Group lifecycle management
│       ├── joinService.js    # Join / leave / active group tracking
│       ├── billReconciliation.js  # Delivery fee split calculator
│       ├── notificationService.js # In-app notifications
│       └── validation.js    # Input validation helpers
├── test/                     # 28 unit + integration tests
├── firebase.json             # Firebase Hosting + Firestore config
├── firestore.rules           # Firestore security rules
└── vite.config.js
```

---

## 🔧 Getting Started

### Prerequisites
- Node.js ≥ 18
- Firebase CLI (`npm install -g firebase-tools`)
- A Firebase project with **Firestore** and **Google Auth** enabled

### Local Development

```bash
# 1. Clone the repo
git clone https://github.com/rthota409-max/OrderNearMe.git
cd OrderNearMe

# 2. Install dependencies
npm install

# 3. Add your Firebase config
cp .env.example .env.local
# Fill in your Firebase project values in .env.local

# 4. Start the dev server
npm run dev
```

App runs at `http://localhost:5173`

### Run Tests

```bash
npm test
```

All 28 tests should pass ✅

### Deploy to Firebase

```bash
npm run build
firebase deploy
```

---

## 🔐 Authentication & Privacy

- Users sign in with **Google OAuth** — one Google account = one profile
- Profile (name + address) is saved once and persists across sessions
- Location is used **only** for the 150m proximity filter — never stored in Firestore
- Firestore security rules ensure users can only read/write their own data

---

## 📱 Supported Delivery Apps

| App | Status |
|---|---|
| 🟢 Blinkit | ✅ Supported |
| 🟠 Instamart (Swiggy) | ✅ Supported |
| 🔵 Zepto | ✅ Supported |

> Only grocery/essentials delivery apps are supported by design.

---

## 🗺️ How It Works

```
1. Sign in with Google
2. Allow location access (used only for proximity filtering)
3. Set your name + hostel/PG address (once)
4. Browse nearby orders OR post your own
5. Join a group → chat with members → place orders on the app
6. Split the delivery fee equally — everyone saves!
```

---

## 🧪 Testing

The test suite covers:

- ✅ Bill reconciliation (equal fee splits, edge cases)
- ✅ Order validation (platform, amount, address checks)
- ✅ Full order lifecycle scenarios (create → join → complete → expire)
- ✅ Firestore mock integration

```bash
npm test
# 28 passing
```

---

## 🤝 Contributing

Pull requests are welcome! For major changes, please open an issue first to discuss what you'd like to change.

1. Fork the repo
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

---

## 📄 License

This project is licensed under the **MIT License** — see the [LICENSE](LICENSE) file for details.

---

## 👨‍💻 Author

**Ramcharan Thota**  
[![GitHub](https://img.shields.io/badge/GitHub-rthota409--max-181717?style=flat&logo=github)](https://github.com/rthota409-max)

---

<div align="center">
  <sub>Built with ❤️ for hostel life · <a href="https://ordernearme-8e448.web.app">Try the live app →</a></sub>
</div>
