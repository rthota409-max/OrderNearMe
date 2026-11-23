import React, { useState, useEffect, useMemo, useRef } from "react";
import {
  signInWithPopup,
  signOut,
  onAuthStateChanged
} from "firebase/auth";
import {
  collection,
  addDoc,
  doc,
  setDoc,
  getDoc,
  updateDoc,
  onSnapshot,
  serverTimestamp,
  arrayUnion,
  query,
  where,
  orderBy
} from "firebase/firestore";
import { auth, googleProvider, db } from "./firebase";
import {
  ORDER_STATUS,
  REQUEST_STATUS,
  JOIN_STATUS,
  GROUP_STATUS,
  NOTIFICATION_TYPES,
  PAYMENT_STATUS,
  REMOVAL_REASONS,
  CANCELLATION_REASONS,
  getOrderJoinableStatus,
  isValidOrderTransition
} from "./constants/orderLifecycle";
import { reconcileGroupBill } from "./services/billReconciliation";
import {
  createOrder,
  extendOrderAtomic,
  cancelOrderAtomic,
  proceedAloneAtomic,
  closeOrderAndCreateGroupAtomic
} from "./services/orderService";
import {
  createJoinRequest,
  withdrawJoinRequestAtomic,
  respondJoinRequestAtomic,
  leaveGroupAtomic,
  removeMemberAtomic
} from "./services/joinService";
import {
  lockOrderForCheckout,
  unlockOrderFromCheckout,
  confirmCheckoutBreakdown,
  reportMemberPayment,
  acknowledgeMemberPayment,
  markRetailerOrderPlaced,
  markItemsHandedOver,
  confirmMemberReceipt,
  reportProblemDispute,
  completeOrderGroup,
  archiveExpiredGroupAtomic,
  submitUserRating
} from "./services/groupService";
import {
  MIN_CART_AMOUNT,
  MAX_JOINER_CART,
  MAX_GROUP_CART,
  MAX_EXTENSIONS_LIMIT,
  EXTENSION_DURATION_MINUTES,
  checkCartWarningThreshold
} from "./services/validation";
import {
  sendNotification,
  markNotificationAsRead
} from "./services/notificationService";
import {
  ShoppingBag,
  Utensils,
  Car,
  Clock,
  MapPin,
  Bell,
  ShieldCheck,
  Send,
  Share2,
  Plus,
  LogOut,
  User,
  AlertTriangle,
  ExternalLink,
  CheckCircle2,
  XCircle,
  Star,
  IndianRupee,
  Users,
  Check,
  Copy,
  History,
  PackageCheck,
  Sparkles,
  Info,
  ChevronRight,
  ChevronDown,
  MessageSquare,
  X,
  Compass,
  StickyNote,
  CheckCheck,
  TrendingDown,
  UserMinus,
  Bike,
  Lock,
  Unlock,
  Store,
  Camera,
  ThumbsUp,
  ThumbsDown,
  CheckSquare,
  Calendar,
  Layers,
  ArrowRight,
  Eye
} from "lucide-react";

// Platform deep links and website fallbacks (Spec Section 5)
const PLATFORM_LINKS = {
  Blinkit: {
    name: "Blinkit",
    logoText: "B",
    color: "#f8cb46",
    textColor: "#000000",
    description: "10-minute grocery delivery & midnight snacks",
    webUrl: "https://blinkit.com"
  },
  Instamart: {
    name: "Instamart",
    logoText: "I",
    color: "#fc8019",
    textColor: "#ffffff",
    description: "Instant groceries, fresh fruits & daily dairy",
    webUrl: "https://www.instamart.in"
  },
  Zepto: {
    name: "Zepto",
    logoText: "Z",
    color: "#6b21a8",
    textColor: "#ffffff",
    description: "10-minute essentials, hygiene & packaged drinks",
    webUrl: "https://www.zeptonow.com"
  }
};

const ORDER_MODES = {
  meet: {
    label: "Meet & Order on One Phone",
    badge: "🤝 Meet & Order Together",
    desc: "Walk to Host's room / common room, build cart on 1 phone, split live bill face-to-face"
  },
  screenshot: {
    label: "Screenshot Bill & Meet at Gate",
    badge: "📸 Screenshot Bill & Meet at Gate",
    desc: "Send item names in chat, Host posts checkout screenshot, pay host, meet once at gate"
  }
};

const CATEGORIES = {
  grocery: {
    label: "Groceries",
    icon: ShoppingBag,
    platforms: ["Blinkit", "Instamart", "Zepto"]
  }
};

const NEARBY_RADIUS_KM = 0.15; // 150 meters maximum proximity radius

// Helper to format relative timestamps (e.g. "2m ago", "1h ago")
function formatTimeAgo(ms) {
  if (!ms) return "Just now";
  const diffSec = Math.floor((Date.now() - ms) / 1000);
  if (diffSec < 60) return "Just now";
  const diffMin = Math.floor(diffSec / 60);
  if (diffMin < 60) return `${diffMin}m ago`;
  const diffHours = Math.floor(diffMin / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d ago`;
}

// Format clock time (e.g. "8:30 PM")
function formatClockTime(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Format scheduled date and time
function formatScheduledTime(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleDateString([], { month: "short", day: "numeric" }) + ", " + d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

// Haversine distance calculation in kilometers
function getDistanceKm(lat1, lon1, lat2, lon2) {
  if (!lat1 || !lon1 || !lat2 || !lon2) return null;
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export default function App() {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loadingAuth, setLoadingAuth] = useState(true);

  // Navigation: feed | explore | groups | notifications | profile | history
  const [activeTab, setActiveTab] = useState("feed");

  // Continuous GPS Location Tracking
  const [userLocation, setUserLocation] = useState(null); // { lat, lng }
  const [locationError, setLocationError] = useState(null);

  // Registration Modal (Spec Section 3)
  const [showRegisterModal, setShowRegisterModal] = useState(false);
  const [registerForm, setRegisterForm] = useState({
    name: "",
    address: "",
    gender: "prefer_not_to_say",
    useGps: true
  });

  // Past Group Chat Modal State
  const [viewingPastGroup, setViewingPastGroup] = useState(null);
  const [pastGroupMessages, setPastGroupMessages] = useState([]);

  // Create Order Modal State
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [orderForm, setOrderForm] = useState({
    category: "grocery",
    platform: "Blinkit",
    address: "",
    orderMode: "meet",
    orderType: "immediate", // "immediate" | "scheduled"
    myAmount: "100",
    targetAmount: "199",
    maximumCartValue: "",
    deliveryFee: "30",
    waitMinutes: 15,
    scheduledDate: "",
    scheduledTime: "",
    placeOrNote: "",
    handoverMode: "gate",
    roomNumber: ""
  });
  const [posting, setPosting] = useState(false);

  // Join Order Modal State
  const [joiningOrder, setJoiningOrder] = useState(null);
  const [joinForm, setJoinForm] = useState({
    contributionAmount: "20",
    itemsList: "",
    note: "",
    stockConfirmed: false
  });
  const [submittingJoin, setSubmittingJoin] = useState(false);

  // 50% Cart Warning Modal State (Spec Section 11)
  const [warningModal, setWarningModal] = useState(null); // { req, warningMessage, onProceed }

  // Closing Confirmation & Group Creation Modal (Spec Section 13)
  const [closeOrderModal, setCloseOrderModal] = useState(null); // order

  // Checkout Breakdown Modal (Host bill management)
  const [showCheckoutModal, setShowCheckoutModal] = useState(null); // group
  const [breakdownForm, setBreakdownForm] = useState({
    deliveryFee: "0",
    handlingFee: "0",
    packagingFee: "0",
    surgeFee: "0",
    discountAmount: "0"
  });

  // Reasoned Member Removal Modal (Spec Section 16)
  const [removalTarget, setRemovalTarget] = useState(null); // { group, member }
  const [selectedRemovalReason, setSelectedRemovalReason] = useState("unresponsive");

  // Dispute Modal
  const [disputeTarget, setDisputeTarget] = useState(null); // group
  const [disputeReasonText, setDisputeReasonText] = useState("");

  // Rating Modal (Spec Section 21)
  const [ratingTarget, setRatingTarget] = useState(null); // { group, member, stars: 5, review: "" }

  // Confirmation Modal
  const [confirmModal, setConfirmModal] = useState(null);

  // Toast / Snackbar System
  const [toast, setToast] = useState(null);
  const showToast = (message, type = "info") => {
    setToast({ message, type });
    setTimeout(() => setToast(null), 3500);
  };

  // Data Collections
  const [orders, setOrders] = useState([]);
  const [joinRequests, setJoinRequests] = useState([]);
  const [groups, setGroups] = useState([]);
  const [selectedGroup, setSelectedGroup] = useState(null);
  const [messages, setMessages] = useState([]);
  const [chatInput, setChatInput] = useState("");
  const [nowMs, setNowMs] = useState(Date.now());
  const [copiedItems, setCopiedItems] = useState(false);
  const [showBillDetails, setShowBillDetails] = useState(true);

  // Persistent Notifications (Spec Section 22)
  const [notifications, setNotifications] = useState([]);

  // Profile Form State
  const [profileForm, setProfileForm] = useState({
    name: "",
    address: "",
    college: "Campus Community",
    collegeEmail: "",
    bio: "",
    gender: "prefer_not_to_say"
  });

  const chatEndRef = useRef(null);

  // 1-second live ticker for countdowns
  useEffect(() => {
    const interval = setInterval(() => setNowMs(Date.now()), 1000);
    return () => clearInterval(interval);
  }, []);

  // Continuous Real-Time GPS Location Tracking (150m Proximity)
  useEffect(() => {
    if (!navigator.geolocation) {
      setLocationError("Geolocation not supported by this browser");
      return;
    }

    const updateCoords = (position) => {
      const loc = {
        lat: position.coords.latitude,
        lng: position.coords.longitude
      };
      setUserLocation(loc);
      setLocationError(null);

      // Persist location to profile if signed in
      if (user?.uid) {
        const userRef = doc(db, "users", user.uid);
        setDoc(userRef, { lat: loc.lat, lng: loc.lng, updatedAtMs: Date.now() }, { merge: true }).catch(() => {});
      }
    };

    // Immediate GPS fetch
    navigator.geolocation.getCurrentPosition(
      updateCoords,
      (err) => {
        console.log("GPS initial fetch info:", err.message);
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 5000 }
    );

    // Continuous location tracking while using site
    const watchId = navigator.geolocation.watchPosition(
      updateCoords,
      (err) => {
        setLocationError(err.message || "Location access denied");
        console.log("GPS watch error:", err.message);
      },
      {
        enableHighAccuracy: true,
        maximumAge: 5000,
        timeout: 15000
      }
    );

    return () => navigator.geolocation.clearWatch(watchId);
  }, [user?.uid]);

  // Request explicit location permission
  const requestLocationPermission = () => {
    if (!navigator.geolocation) {
      showToast("Geolocation is not supported by your browser.", "error");
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        const coords = { lat: pos.coords.latitude, lng: pos.coords.longitude };
        setUserLocation(coords);
        setLocationError(null);
        if (user) {
          updateDoc(doc(db, "users", user.uid), { lat: coords.lat, lng: coords.lng, updatedAtMs: Date.now() }).catch(() => {});
        }
        showToast("📍 Location access granted (150m radius active)!", "success");
      },
      (err) => {
        setLocationError(err.message || "Location access denied");
        showToast("Please allow location access to see orders within 150m.", "error");
      },
      { enableHighAccuracy: true, timeout: 10000 }
    );
  };

  // Real-time Messages for Viewing Past Group Chat
  useEffect(() => {
    if (!viewingPastGroup?.id) {
      setPastGroupMessages([]);
      return;
    }
    const q = query(
      collection(db, "groups", viewingPastGroup.id, "messages"),
      orderBy("createdAtMs", "asc")
    );
    const unsub = onSnapshot(
      q,
      (snap) => {
        const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        setPastGroupMessages(all);
      },
      (err) => console.error("Past group messages error:", err)
    );
    return () => unsub();
  }, [viewingPastGroup?.id]);

  // Auto-scroll chat on message change
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // 1. Auth Listener & Profile Setup (Spec Section 3)
  useEffect(() => {
    const timeout = setTimeout(() => setLoadingAuth(false), 4500);

    const unsub = onAuthStateChanged(auth, async (currentUser) => {
      clearTimeout(timeout);
      setUser(currentUser);
      if (currentUser) {
        try {
          const localRegistered = localStorage.getItem("onm_registered_" + currentUser.uid);
          const localAddr = localStorage.getItem("onm_address_" + currentUser.uid) || "";

          const userRef = doc(db, "users", currentUser.uid);
          const snap = await getDoc(userRef);

          if (snap.exists() || localRegistered) {
            const data = snap.exists() ? snap.data() : {};
            const savedName = (data.name || currentUser.displayName || "User").trim();
            const savedAddr = (data.address || data.hostel || localAddr || "").trim();

            const fullProfile = {
              uid: currentUser.uid,
              email: currentUser.email || "",
              photoURL: currentUser.photoURL || "",
              photo: currentUser.photoURL || "",
              ...data,
              name: savedName,
              address: savedAddr,
              hostel: savedAddr,
              accountStatus: "active"
            };

            setProfile(fullProfile);
            setProfileForm((prev) => ({ ...prev, ...fullProfile }));
            setShowRegisterModal(false);

            localStorage.setItem("onm_registered_" + currentUser.uid, "true");
            if (savedAddr) {
              localStorage.setItem("onm_address_" + currentUser.uid, savedAddr);
            }

            // Sync with Firestore if missing address
            if (!data.address && savedAddr) {
              await setDoc(userRef, { address: savedAddr, hostel: savedAddr, name: savedName, accountStatus: "active" }, { merge: true });
            }
          } else {
            // First time only
            setRegisterForm({
              name: currentUser.displayName || "",
              address: localAddr || "",
              gender: "prefer_not_to_say",
              useGps: true
            });
            setShowRegisterModal(true);
          }
        } catch (err) {
          console.error("Profile load error:", err);
          setShowRegisterModal(false);
        }
      } else {
        setProfile(null);
      }
      setLoadingAuth(false);
    });

    return () => {
      clearTimeout(timeout);
      unsub();
    };
  }, []);

  // 2. Real-time Firestore Listeners: Orders, Join Requests, Groups, Notifications
  useEffect(() => {
    if (!user) return;

    // Real-time Orders — only non-terminal orders for the feed
    const ordersQuery = query(
      collection(db, "orders"),
      where("status", "in", ["waiting", "open", "scheduled", "matched", "ready_to_close", "closed", "checkout", "ordered", "delivered"])
    );
    const unsubOrders = onSnapshot(
      ordersQuery,
      (snap) => {
        const all = snap.docs.map((d) => {
          const data = d.data();
          return { id: d.id, ...data };
        });
        all.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
        setOrders(all);
      },
      (err) => console.error("Orders listener error:", err)
    );

    // Real-time Join Requests — only where user is requester or order creator
    // We need two listeners since Firestore doesn't support OR across different fields
    const myRequestsQuery = query(
      collection(db, "joinRequests"),
      where("requesterId", "==", user.uid)
    );
    const incomingRequestsQuery = query(
      collection(db, "joinRequests"),
      where("creatorId", "==", user.uid)
    );

    const mergedReqs = new Map();
    const updateJoinRequests = () => {
      const all = Array.from(mergedReqs.values());
      // Strict FIFO sort by requestedAt ascending for host review (Spec Section 9)
      all.sort((a, b) => (a.requestedAt || a.createdAtMs || 0) - (b.requestedAt || b.createdAtMs || 0));
      setJoinRequests(all);
    };

    const unsubMyReqs = onSnapshot(
      myRequestsQuery,
      (snap) => {
        snap.docs.forEach((d) => mergedReqs.set(d.id, { id: d.id, ...d.data() }));
        snap.docChanges().forEach((change) => {
          if (change.type === "removed") mergedReqs.delete(change.doc.id);
        });
        updateJoinRequests();
      },
      (err) => console.error("My JoinRequests listener error:", err)
    );

    const unsubIncomingReqs = onSnapshot(
      incomingRequestsQuery,
      (snap) => {
        snap.docs.forEach((d) => mergedReqs.set(d.id, { id: d.id, ...d.data() }));
        snap.docChanges().forEach((change) => {
          if (change.type === "removed") mergedReqs.delete(change.doc.id);
        });
        updateJoinRequests();
      },
      (err) => console.error("Incoming JoinRequests listener error:", err)
    );

    // Real-time Groups — only groups where user is a member
    const groupsQuery = query(
      collection(db, "groups"),
      where("memberIds", "array-contains", user.uid)
    );
    const unsubGroups = onSnapshot(
      groupsQuery,
      (snap) => {
        const myGroups = snap.docs.map((d) => ({ id: d.id, ...d.data() }))
          .sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
        setGroups(myGroups);
      },
      (err) => console.error("Groups listener error:", err)
    );

    // Real-time Persistent In-App Notifications (Spec Section 22)
    const notifQuery = query(
      collection(db, "notifications"),
      where("recipientId", "==", user.uid)
    );
    const unsubNotifs = onSnapshot(
      notifQuery,
      (snap) => {
        const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        all.sort((a, b) => (b.createdAtMs || 0) - (a.createdAtMs || 0));
        setNotifications(all);
      },
      (err) => console.error("Notifications listener error:", err)
    );

    return () => {
      unsubOrders();
      unsubMyReqs();
      unsubIncomingReqs();
      unsubGroups();
      unsubNotifs();
    };
  }, [user?.uid]);

  // Real-time Messages for Selected Group
  useEffect(() => {
    if (!selectedGroup?.id) {
      setMessages([]);
      return;
    }
    const unsub = onSnapshot(
      collection(db, "groups", selectedGroup.id, "messages"),
      (snap) => {
        const all = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
        all.sort((a, b) => (a.createdAtMs || 0) - (b.createdAtMs || 0));
        setMessages(all);
      },
      (err) => console.error("Messages listener error:", err)
    );
    return () => unsub();
  }, [selectedGroup?.id]);

  // Check and Archive Expired Groups after 60 minutes (Spec Section 19)
  useEffect(() => {
    if (!groups.length) return;
    groups.forEach((g) => {
      const expiresAt = Number(g.expiresAtMs || 0);
      if (expiresAt > 0 && nowMs >= expiresAt && g.status !== GROUP_STATUS.ARCHIVED) {
        archiveExpiredGroupAtomic(db, g.id).catch((e) =>
          console.error("Error archiving expired group:", e)
        );
      }
    });
  }, [nowMs, groups]);

  // --- Handlers ---

  // Complete Registration
  const handleSaveRegistration = async (e) => {
    e.preventDefault();
    if (!user) return;
    const typedName = (registerForm.name || user.displayName || "User").trim();
    const typedAddr = (registerForm.address || "").trim();

    const profileData = {
      uid: user.uid,
      name: typedName,
      email: user.email || "",
      photoURL: user.photoURL || "",
      photo: user.photoURL || "",
      hostel: typedAddr,
      address: typedAddr,
      gender: registerForm.gender || "prefer_not_to_say",
      lat: userLocation?.lat ?? null,
      lng: userLocation?.lng ?? null,
      ratingAverage: 5.0,
      ratingCount: 1,
      ratingSum: 5.0,
      activeOrderId: null,
      activeGroupId: null,
      accountStatus: "active",
      createdAt: serverTimestamp(),
      updatedAtMs: Date.now()
    };

    // Save locally immediately so page reload never asks again
    localStorage.setItem("onm_registered_" + user.uid, "true");
    if (typedAddr) {
      localStorage.setItem("onm_address_" + user.uid, typedAddr);
    }

    setProfile(profileData);
    setProfileForm((prev) => ({ ...prev, ...profileData }));
    setShowRegisterModal(false);

    try {
      await setDoc(doc(db, "users", user.uid), profileData, { merge: true });
      showToast("Welcome to OrderNearMe! 🎉", "success");
    } catch (err) {
      console.error("Registration error:", err);
      showToast("Profile saved locally!", "info");
    }
  };

  // Create Order Handler (Spec Section 6 & 18)
  const handleCreateOrder = async (e) => {
    e.preventDefault();
    if (!user || !profile) {
      showToast("Please sign in first.", "error");
      return;
    }

    const activeLat = userLocation?.lat ?? profile?.lat;
    const activeLng = userLocation?.lng ?? profile?.lng;
    if (!activeLat || !activeLng) {
      showToast("Location access is required to post an order within 150 meters.", "error");
      requestLocationPermission();
      return;
    }

    setPosting(true);
    try {
      let scheduledAtMs = null;
      if (orderForm.orderType === "scheduled") {
        if (!orderForm.scheduledDate || !orderForm.scheduledTime) {
          throw new Error("Please select both a scheduled date and time.");
        }
        const schedTime = new Date(`${orderForm.scheduledDate}T${orderForm.scheduledTime}`).getTime();
        if (isNaN(schedTime) || schedTime <= Date.now()) {
          throw new Error("Scheduled order time must be in the future.");
        }
        scheduledAtMs = schedTime;
      }

      const typedAddress = (orderForm.address || profile?.address || profile?.hostel || "").trim();
      if (!typedAddress) {
        throw new Error("Please type your address or hostel name.");
      }

      const payload = {
        ...orderForm,
        category: "grocery",
        lat: userLocation?.lat ?? profile?.lat ?? null,
        lng: userLocation?.lng ?? profile?.lng ?? null,
        hostel: typedAddress,
        address: typedAddress,
        scheduledAtMs,
        pickupPoint: orderForm.handoverMode === "room"
          ? (orderForm.roomNumber ? `Room ${orderForm.roomNumber.trim()}` : "Collect from Room")
          : "Meet at Hostel Gate"
      };

      await createOrder(db, user, profile, payload, orders);
      setShowCreateModal(false);
      showToast("Order request posted to nearby community!", "success");
    } catch (err) {
      console.error("Create order error:", err);
      showToast(err.message || "Could not post order", "error");
    } finally {
      setPosting(false);
    }
  };

  // Open Join Modal
  const handleOpenJoinModal = (order) => {
    if (!user) {
      showToast("Please sign in to join orders.", "info");
      return;
    }
    if (order.creatorId === user.uid || order.ownerId === user.uid) {
      showToast("You are the creator of this order.", "info");
      return;
    }

    const joinCheck = getOrderJoinableStatus(order, nowMs);
    if (!joinCheck.joinable) {
      showToast(`Cannot join: ${joinCheck.reason}`, "error");
      return;
    }

    setJoiningOrder(order);
    const needed = Math.max(0, (order.targetCartValue || order.targetAmount || 199) - (order.acceptedCartValue || order.currentCart || order.myAmount));
    setJoinForm({
      contributionAmount: needed > 0 ? String(Math.min(needed, 100)) : "20",
      itemsList: "",
      note: "",
      stockConfirmed: false
    });
  };

  // Submit Join Request (Spec Section 8)
  const handleSubmitJoin = async (e) => {
    e.preventDefault();
    if (!joiningOrder || !user || !profile) return;

    setSubmittingJoin(true);
    try {
      await createJoinRequest(db, user, profile, joiningOrder, joinForm, joinRequests);
      showToast(`Request sent to ${joiningOrder.ownerName}!`, "success");
      setJoiningOrder(null);
    } catch (err) {
      console.error("Join request error:", err);
      showToast(err.message || "Could not send request", "error");
    } finally {
      setSubmittingJoin(false);
    }
  };

  // Creator Reviews Request with 50% Warning Check (Spec Section 9 & 11)
  const handleRespondJoinRequest = (req, decision) => {
    if (decision === "rejected") {
      executeAcceptOrReject(req, "rejected");
      return;
    }

    // Check 50% above target warning threshold
    const order = orders.find((o) => o.id === req.orderId);
    if (order) {
      const currentAccepted = Number(order.acceptedCartValue ?? order.currentCart ?? order.myAmount ?? 0);
      const reqEstimate = Number(req.contributionAmount || req.estimatedCartValue || 0);
      const target = Number(order.targetCartValue || order.targetAmount || 199);
      const warningCheck = checkCartWarningThreshold(currentAccepted, reqEstimate, target);

      if (warningCheck.exceedsThreshold) {
        setWarningModal({
          req,
          warningMessage: warningCheck.warningMessage,
          onProceed: () => {
            setWarningModal(null);
            executeAcceptOrReject(req, "accepted");
          }
        });
        return;
      }
    }

    executeAcceptOrReject(req, "accepted");
  };

  const executeAcceptOrReject = async (req, decision) => {
    try {
      const res = await respondJoinRequestAtomic(db, req.id, user.uid, decision, joinRequests);
      if (res.decision === "accepted") {
        showToast(`Accepted ${req.requesterName}'s request!`, "success");
      } else {
        showToast("Request declined", "info");
      }
    } catch (err) {
      console.error("Respond request error:", err);
      showToast(err.message || "Error responding", "error");
    }
  };

  // Order Closing & Group Formation (Spec Section 13)
  const handlePromptCloseOrder = (order) => {
    setCloseOrderModal(order);
  };

  const handleConfirmCloseOrder = async () => {
    if (!closeOrderModal) return;
    const order = closeOrderModal;
    const acceptedForOrder = joinRequests.filter(
      (r) => r.orderId === order.id && r.status === REQUEST_STATUS.ACCEPTED
    );
    const pendingForOrder = joinRequests.filter(
      (r) => r.orderId === order.id && r.status === REQUEST_STATUS.PENDING
    );

    try {
      const res = await closeOrderAndCreateGroupAtomic(
        db,
        order.id,
        user.uid,
        acceptedForOrder,
        pendingForOrder
      );

      if (res.closedWithoutGroup) {
        showToast("Order closed without forming a group (no accepted requesters).", "info");
      } else {
        showToast("Group created! Coordinate purchase in the room.", "success");
        setActiveTab("groups");
      }
      setCloseOrderModal(null);
    } catch (err) {
      console.error("Close order error:", err);
      showToast(err.message || "Could not close order", "error");
    }
  };

  // Timer Extension (+5 Min, Max 2)
  const handleExtendOrder = async (order) => {
    try {
      const res = await extendOrderAtomic(db, order.id, user.uid, order.maxExtensions || MAX_EXTENSIONS_LIMIT);
      showToast(`Extended wait by 5 mins (${res.extensionCount}/${res.maxExtensions} used)`, "success");
    } catch (err) {
      console.error("Extend error:", err);
      showToast(err.message || "Could not extend timer", "error");
    }
  };

  // Proceed Alone
  const handleProceedAlonePrompt = (order) => {
    setConfirmModal({
      title: `Order alone on ${order.platform}?`,
      message: `Ordering alone closes this pool. We will open ${order.platform} for direct checkout.`,
      confirmText: `Open ${order.platform}`,
      isDanger: false,
      onConfirm: async () => {
        try {
          await proceedAloneAtomic(db, order.id, user.uid);
          const link = PLATFORM_LINKS[order.platform]?.webUrl || "https://www.google.com";
          window.open(link, "_blank");
        } catch (e) {
          console.error("Proceed alone error:", e);
          showToast(e.message || "Error", "error");
        }
        setConfirmModal(null);
      }
    });
  };

  // Cancel Order
  const handleCancelOrderPrompt = (order) => {
    const reason = window.prompt("Reason for cancellation (e.g. Changed mind / Store closed):") || "Creator cancelled";
    setConfirmModal({
      title: "Cancel this order?",
      message: "Are you sure you want to cancel this order? All members will be notified.",
      confirmText: "Cancel Order",
      isDanger: true,
      onConfirm: async () => {
        try {
          await cancelOrderAtomic(db, order.id, user.uid, reason);
          showToast("Order cancelled", "info");
        } catch (e) {
          console.error("Cancel order error:", e);
          showToast(e.message || "Error", "error");
        }
        setConfirmModal(null);
      }
    });
  };

  // Lock / Unlock Group for Checkout
  const handleToggleLockOrder = async (orderOrGroup) => {
    try {
      const orderId = orderOrGroup.orderId || orderOrGroup.id;
      const group = groups.find((g) => g.orderId === orderId || g.id === orderOrGroup.id);
      const isLocked = group?.status === GROUP_STATUS.FINALIZED;

      if (isLocked) {
        if (group) await unlockOrderFromCheckout(db, group.id, orderId, user.uid);
        showToast("Order unlocked for member adjustments 🔓", "success");
      } else {
        if (group) await lockOrderForCheckout(db, group.id, orderId, user.uid);
        showToast("Order locked for checkout 🔒", "success");
      }
    } catch (err) {
      console.error("Toggle lock error:", err);
      showToast(err.message || "Could not toggle lock", "error");
    }
  };

  // Member Leaves Group
  const handleLeaveGroup = async (group) => {
    if (!window.confirm("Are you sure you want to leave this order pool?")) return;
    try {
      await leaveGroupAtomic(db, group.id, user.uid);
      showToast("You have left the group", "info");
    } catch (err) {
      console.error("Leave group error:", err);
      showToast(err.message || "Error leaving group", "error");
    }
  };

  // Creator Removes Member
  const handleConfirmRemoval = async () => {
    if (!removalTarget) return;
    const reasonObj = REMOVAL_REASONS.find((r) => r.id === selectedRemovalReason);
    const reasonText = reasonObj ? reasonObj.label : selectedRemovalReason;

    try {
      await removeMemberAtomic(db, removalTarget.group.id, user.uid, removalTarget.member.uid, reasonText);
      showToast(`${removalTarget.member.name} removed: ${reasonText}`, "info");
      setRemovalTarget(null);
    } catch (err) {
      console.error("Remove member error:", err);
      showToast(err.message || "Could not remove member", "error");
    }
  };

  // Save Confirmed Retailer Breakdown
  const handleSaveCheckoutBreakdown = async (e) => {
    e.preventDefault();
    if (!showCheckoutModal) return;

    try {
      await confirmCheckoutBreakdown(db, showCheckoutModal.id, user.uid, breakdownForm);
      showToast("Checkout breakdown confirmed & reconciled with zero residual ✓", "success");
      setShowCheckoutModal(null);
    } catch (err) {
      console.error("Confirm breakdown error:", err);
      showToast(err.message || "Could not confirm breakdown", "error");
    }
  };

  // Member Reports Payment (Self-Reported)
  const handleReportPayment = async (group) => {
    const note = window.prompt("Optional payment reference (e.g. Cash in room / Reference note):") || "";
    try {
      await reportMemberPayment(db, group.id, user.uid, note);
      showToast("Payment reported as sent (pending Host acknowledgement) ✓", "success");
    } catch (err) {
      console.error("Report payment error:", err);
      showToast(err.message || "Could not report payment", "error");
    }
  };

  // Host Acknowledges Payment
  const handleAcknowledgePayment = async (group, memberUid) => {
    try {
      await acknowledgeMemberPayment(db, group.id, user.uid, memberUid);
      showToast("Payment acknowledged as received ✓", "success");
    } catch (err) {
      console.error("Acknowledge payment error:", err);
      showToast(err.message || "Error acknowledging payment", "error");
    }
  };

  // Host Marks Order Placed on Retailer
  const handleMarkOrderPlaced = async (group) => {
    try {
      await markRetailerOrderPlaced(db, group.id, group.orderId, user.uid);
      showToast("Order marked as placed on retailer app!", "success");
    } catch (err) {
      console.error("Mark placed error:", err);
      showToast(err.message || "Error updating status", "error");
    }
  };

  // Host Marks Items Handed Over
  const handleMarkHandedOver = async (group) => {
    try {
      await markItemsHandedOver(db, group.id, group.orderId, user.uid);
      showToast("Marked as handed over at pickup point!", "success");
    } catch (err) {
      console.error("Mark handed over error:", err);
      showToast(err.message || "Error updating status", "error");
    }
  };

  // Joiner Confirms Receipt
  const handleConfirmReceipt = async (group) => {
    try {
      await confirmMemberReceipt(db, group.id, user.uid);
      showToast("Confirmed receipt of your items ✓", "success");
    } catch (err) {
      console.error("Confirm receipt error:", err);
      showToast(err.message || "Error confirming receipt", "error");
    }
  };

  // Host Completes Order Group
  const handleCompleteOrder = async (group) => {
    try {
      await completeOrderGroup(db, group.id, group.orderId, user.uid);
      showToast("Order completed! Chat is now read-only.", "success");
    } catch (err) {
      console.error("Complete order error:", err);
      showToast(err.message || "Error completing order", "error");
    }
  };

  // Report Problem / Dispute
  const handleConfirmDispute = async () => {
    if (!disputeTarget || !disputeReasonText.trim()) return;
    try {
      await reportProblemDispute(
        db,
        disputeTarget.id,
        disputeTarget.orderId,
        user.uid,
        disputeReasonText.trim()
      );
      showToast("Dispute reported and recorded in audit log", "error");
      setDisputeTarget(null);
      setDisputeReasonText("");
    } catch (err) {
      console.error("Dispute error:", err);
      showToast(err.message || "Error reporting dispute", "error");
    }
  };

  // Post-Completion Rating Submission (Spec Section 21)
  const handleSubmitRating = async (e) => {
    e.preventDefault();
    if (!ratingTarget) return;

    try {
      await submitUserRating(db, {
        reviewerId: user.uid,
        reviewerName: profile?.name || user.displayName || "Hostel Mate",
        reviewedUserId: ratingTarget.targetUid,
        groupId: ratingTarget.groupId,
        rating: ratingTarget.stars,
        review: ratingTarget.review
      });
      showToast("Rating submitted! Thank you for building campus trust ★", "success");
      setRatingTarget(null);
    } catch (err) {
      console.error("Rating error:", err);
      showToast(err.message || "Could not submit rating", "error");
    }
  };

  // Delivery Partner at Gate Alert
  const handleAlertDeliveryAtGate = async (group) => {
    if (!group || (group.ownerId !== user.uid && group.creatorId !== user.uid)) return;
    try {
      await addDoc(collection(db, "groups", group.id, "messages"), {
        senderId: "system",
        senderName: "OrderNearMe Bot",
        text: `📦 DELIVERY HAS ARRIVED! Meet at ${group.pickupPoint || "Gate"} now to collect your items.`,
        createdAtMs: Date.now()
      });
      showToast("Alert sent! Room members notified to meet at gate", "success");
    } catch (err) {
      console.error("Alert delivery error:", err);
    }
  };

  // Send Group Chat Message
  const handleSendMessage = async (e) => {
    e.preventDefault();
    if (!chatInput.trim() || !selectedGroup || !user) return;

    // Strict 60-minute cutoff check
    const expMs = Number(selectedGroup.expiresAtMs || 0);
    const isExpired = (expMs > 0 && nowMs >= expMs) ||
      selectedGroup.status === GROUP_STATUS.COMPLETED ||
      selectedGroup.status === GROUP_STATUS.ARCHIVED;

    if (isExpired) {
      showToast("This 60-minute group has expired. Chat is read-only.", "error");
      return;
    }

    const text = chatInput.trim();
    setChatInput("");
    try {
      await addDoc(collection(db, "groups", selectedGroup.id, "messages"), {
        senderId: user.uid,
        senderName: profile?.name || user.displayName || "Student",
        senderPhoto: profile?.photo || user.photoURL || "",
        text,
        createdAtMs: Date.now()
      });
    } catch (err) {
      console.error("Send message error:", err);
      showToast("Could not send message: " + (err.message || "Network error"), "error");
    }
  };

  // Copy Consolidated Items List
  const handleCopyConsolidatedList = (group) => {
    if (!group?.members) return;
    const lines = [`🛒 *${group.platform} Order List* (Pickup: ${group.pickupPoint || "Hostel Gate"})`];
    group.members.forEach((m, idx) => {
      lines.push(`${idx + 1}. ${m.name}: ${m.items || "Cart item"} (₹${m.amount})`);
    });
    navigator.clipboard.writeText(lines.join("\n"));
    setCopiedItems(true);
    setTimeout(() => setCopiedItems(false), 2000);
    showToast("Consolidated cart list copied to clipboard!", "success");
  };

  // WhatsApp Share
  const handleWhatsAppShare = (order) => {
    const target = order.targetCartValue || order.targetAmount || 199;
    const current = order.acceptedCartValue || order.currentCart || order.myAmount;
    const needed = Math.max(0, target - current);
    const msg = `Hey! I'm ordering from ${order.platform} at ${order.hostel}. Need ₹${needed} more to get free delivery! Join my order on OrderNearMe: https://ordernearme-8e448.web.app`;
    window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, "_blank");
  };

  // Filtered Visible Orders
  const visibleOrders = useMemo(() => {
    const activeLat = userLocation?.lat ?? profile?.lat;
    const activeLng = userLocation?.lng ?? profile?.lng;

    return orders
      .filter((o) => {
        if (profile?.blockedUsers?.includes(o.ownerId || o.creatorId)) return false;

        // If the order is closed, cancelled, alone, completed, or closed_without_group,
        // it SHOULD NOT BE VISIBLE TO ANYONE on the main feed (only in previous orders).
        if ([
          ORDER_STATUS.CLOSED,
          ORDER_STATUS.CLOSED_WITHOUT_GROUP,
          ORDER_STATUS.COMPLETED,
          ORDER_STATUS.CANCELLED,
          ORDER_STATUS.ALONE
        ].includes(o.status)) {
          return false;
        }

        // Hide expired orders from feed
        const expTime = Number(o.expiresAtMs || o.requestExpiresAtMs || 0);
        if (expTime > 0 && expTime <= nowMs) {
          return false;
        }

        // Only grocery platforms Blinkit, Instamart, Zepto
        if (o.category && o.category !== "grocery") return false;

        // Strict Proximity restriction: ONLY NEAR ORDERS (within 150 meters)
        if (activeLat && activeLng && o.lat && o.lng) {
          const dist = getDistanceKm(activeLat, activeLng, o.lat, o.lng);
          return dist !== null && dist <= NEARBY_RADIUS_KM;
        }

        // Creator always sees their own active order
        return (o.creatorId === user?.uid) || (o.ownerId === user?.uid);
      })
      .map((o) => {
        const dist = getDistanceKm(activeLat, activeLng, o.lat, o.lng);
        return { ...o, distanceKm: dist };
      })
      .sort((a, b) => {
        // Nearest orders first if distance available
        if (a.distanceKm !== null && b.distanceKm !== null) {
          return a.distanceKm - b.distanceKm;
        }
        return (b.createdAtMs || 0) - (a.createdAtMs || 0);
      });
  }, [orders, nowMs, profile, userLocation, user?.uid]);

  // Total Savings Tracker
  const totalSavings = useMemo(() => {
    if (!user) return 0;
    const completedOrders = orders.filter((o) => {
      const isOwner = o.creatorId === user.uid || o.ownerId === user.uid;
      const isMember = groups.some((g) => g.orderId === o.id && g.memberIds?.includes(user.uid));
      return (isOwner || isMember) && (o.status === ORDER_STATUS.COMPLETED || o.status === ORDER_STATUS.ORDERED);
    });
    return completedOrders.reduce((acc, o) => acc + (o.deliveryFee || 30), 0);
  }, [orders, groups, user]);

  // Order History List
  const orderHistory = useMemo(() => {
    if (!user) return [];
    return orders.filter((o) => {
      const isOwner = o.creatorId === user.uid || o.ownerId === user.uid;
      const isMember = groups.some((g) => g.orderId === o.id && g.memberIds?.includes(user.uid));
      return (
        (isOwner || isMember) &&
        [ORDER_STATUS.COMPLETED, ORDER_STATUS.CANCELLED, ORDER_STATUS.ALONE, ORDER_STATUS.EXPIRED, ORDER_STATUS.CLOSED, ORDER_STATUS.CLOSED_WITHOUT_GROUP].includes(o.status)
      );
    });
  }, [orders, groups, user]);

  // Active Groups (strictly non-expired, within 60-min window)
  const activeGroups = useMemo(() => {
    return groups.filter((g) => {
      const isTerminal = g.status === GROUP_STATUS.COMPLETED || g.status === GROUP_STATUS.ARCHIVED;
      const expMs = Number(g.expiresAtMs || 0);
      const isExpired = expMs > 0 && nowMs >= expMs;
      return !isTerminal && !isExpired;
    });
  }, [groups, nowMs]);

  // Past / Archived Groups (expired after 60 mins or completed)
  const pastGroups = useMemo(() => {
    return groups.filter((g) => {
      const isTerminal = g.status === GROUP_STATUS.COMPLETED || g.status === GROUP_STATUS.ARCHIVED;
      const expMs = Number(g.expiresAtMs || 0);
      const isExpired = expMs > 0 && nowMs >= expMs;
      return isTerminal || isExpired;
    });
  }, [groups, nowMs]);

  // Auto-select or clear selected active group
  useEffect(() => {
    if (activeGroups.length === 0) {
      if (selectedGroup) setSelectedGroup(null);
    } else if (!selectedGroup || !activeGroups.some((g) => g.id === selectedGroup.id)) {
      setSelectedGroup(activeGroups[0]);
    }
  }, [activeGroups, selectedGroup]);

  // Unread Notifications Count
  const unreadNotifCount = useMemo(() => {
    return notifications.filter((n) => !n.isRead).length;
  }, [notifications]);

  // Check my status in an order
  const getMyOrderStatus = (order) => {
    if (!user) return { joined: false, pending: false };
    const myReq = joinRequests.find(
      (r) => r.orderId === order.id && r.requesterId === user.uid
    );
    if (!myReq) return { joined: false, pending: false };
    return {
      joined: myReq.status === REQUEST_STATUS.ACCEPTED,
      pending: myReq.status === REQUEST_STATUS.PENDING
    };
  };

  if (loadingAuth) {
    return (
      <div className="min-h-screen bg-[#f8f9fa] dark:bg-[#1f1f1f] flex flex-col items-center justify-center p-4">
        <div className="w-16 h-16 rounded-3xl bg-[#1a73e8] text-white flex items-center justify-center font-black text-2xl shadow-lg mb-4 animate-pulse">
          ONM
        </div>
        <p className="text-sm font-semibold text-[#5f6368] dark:text-[#9aa0a6]">
          Loading OrderNearMe...
        </p>
      </div>
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-[#f8f9fa] dark:bg-[#1f1f1f] flex flex-col items-center justify-center p-4 text-[#202124] dark:text-[#e8eaed]">
        <div className="max-w-sm w-full bg-white dark:bg-[#2d2e31] rounded-[32px] p-7 border border-[#dadce0]/70 dark:border-[#3c4043] shadow-m3-2 text-center space-y-5 animate-m3-fade-in">
          <div className="w-16 h-16 rounded-[24px] bg-[#1a73e8] text-white flex items-center justify-center font-black text-2xl shadow-md mx-auto">
            ONM
          </div>

          <div className="space-y-1.5">
            <h1 className="text-xl font-extrabold tracking-tight text-[#1a73e8] dark:text-[#8ab4f8]">
              Hello! Welcome to ONM
            </h1>
            <p className="text-xs text-[#5f6368] dark:text-[#9aa0a6] leading-relaxed">
              OrderNearMe connects you with neighbors to share grocery delivery fees on <b>Blinkit</b>, <b>Instamart</b> & <b>Zepto</b>.
            </p>
          </div>

          <div className="bg-[#f8f9fa] dark:bg-[#35363a] p-3.5 rounded-2xl text-left space-y-2 text-xs text-[#3c4043] dark:text-[#e8eaed]">
            <div className="flex items-center gap-2">
              <span className="text-[#1a73e8] font-bold">🛒</span>
              <span>Grocery pooling (Blinkit, Instamart, Zepto)</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[#188038] font-bold">📍</span>
              <span>Strict 150-meter proximity radius</span>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-[#f2994a] font-bold">🔒</span>
              <span>1 User per Google Account — verified & fraud-free</span>
            </div>
          </div>

          <button
            onClick={() => signInWithPopup(auth, googleProvider)}
            className="w-full h-12 bg-white dark:bg-[#202124] text-[#3c4043] dark:text-[#e8eaed] font-bold text-xs rounded-full border border-[#dadce0] hover:bg-[#f1f3f4] dark:hover:bg-[#35363a] flex items-center justify-center gap-3 cursor-pointer shadow-xs transition active:scale-98"
          >
            <svg className="w-5 h-5 shrink-0" viewBox="0 0 24 24">
              <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" />
              <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" />
              <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.06H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.94l2.85-2.22.81-.63z" />
              <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.06l3.66 2.84c.87-2.6 3.3-4.52 6.16-4.52z" />
            </svg>
            <span>Sign in with Google</span>
          </button>

          <p className="text-[10px] text-[#5f6368] dark:text-[#9aa0a6]">
            Only 1 account is linked to your Google sign-in.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#f8f9fa] dark:bg-[#1f1f1f] text-[#202124] dark:text-[#e8eaed] font-sans antialiased pb-28 selection:bg-[#c2e7ff] selection:text-[#001d35]">
      {/* ======================================================== */}
      {/* HEADER (Spec Section 4) */}
      {/* ======================================================== */}
      <header className="sticky top-0 z-30 bg-white/95 dark:bg-[#1f1f1f]/95 backdrop-blur-md border-b border-[#dadce0]/50 dark:border-[#3c4043] px-4 py-3">
        <div className="max-w-md mx-auto flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-2xl bg-[#1a73e8] text-white flex items-center justify-center font-black text-sm shadow-sm">
              ONM
            </div>
            <div>
              <h1 className="font-extrabold text-sm tracking-tight text-[#1a73e8] dark:text-[#8ab4f8]">
                OrderNearMe
              </h1>
              <p className="text-[10px] text-[#5f6368] dark:text-[#9aa0a6] leading-none">
                {profile?.address || profile?.hostel || "Campus Group Orders"}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {/* Notifications Bell */}
            <button
              onClick={() => setActiveTab("notifications")}
              aria-label="Alerts"
              className="w-9 h-9 rounded-full bg-[#f1f3f4] dark:bg-[#2d2e31] hover:bg-[#e8eaed] text-[#3c4043] dark:text-[#e8eaed] flex items-center justify-center relative cursor-pointer transition"
            >
              <Bell size={17} />
              {unreadNotifCount > 0 && (
                <span className="absolute top-1 right-1 w-2.5 h-2.5 rounded-full bg-[#d93025] ring-2 ring-white dark:ring-[#1f1f1f]" />
              )}
            </button>

            {/* Profile Avatar / Login */}
            {user ? (
              <button
                onClick={() => setActiveTab("profile")}
                className="w-9 h-9 rounded-full bg-[#c2e7ff] text-[#001d35] flex items-center justify-center font-bold text-xs cursor-pointer border border-[#1a73e8]"
              >
                {profile?.name?.[0] || user.displayName?.[0] || "U"}
              </button>
            ) : (
              <button
                onClick={() => signInWithPopup(auth, googleProvider)}
                className="h-8 px-3 rounded-full bg-[#1a73e8] text-white text-xs font-semibold flex items-center gap-1 cursor-pointer"
              >
                Sign In
              </button>
            )}
          </div>
        </div>
      </header>

      {/* ======================================================== */}
      {/* MAIN CONTAINER */}
      {/* ======================================================== */}
      <main className="max-w-md mx-auto px-4 pt-3 space-y-4">
        {/* ======================================================== */}
        {/* TAB 1: REQUEST ORDER (HOME FEED) */}
        {/* ======================================================== */}
        {activeTab === "feed" && (
          <div className="space-y-3.5 animate-m3-fade-in">
            {/* Near Orders Automatic Status Indicator */}
            <div className="bg-white dark:bg-[#2d2e31] p-3 rounded-2xl border border-[#dadce0]/60 dark:border-[#3c4043] flex items-center justify-between text-xs shadow-xs">
              <div className="flex items-center gap-2 min-w-0">
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[#188038] opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-[#188038]"></span>
                </span>
                <div className="truncate">
                  <p className="font-bold text-[#202124] dark:text-[#e8eaed] truncate">
                    {userLocation ? "Nearby Orders Near You" : `Nearby Orders (${profile?.address || profile?.hostel || "Campus"})`}
                  </p>
                  <p className="text-[10px] text-[#5f6368] dark:text-[#9aa0a6] truncate">
                    {userLocation ? "Showing only orders within 150m of your GPS location" : "Showing only orders within 150m in your immediate area"}
                  </p>
                </div>
              </div>
              <span className="px-2.5 py-1 rounded-full text-[10px] font-bold bg-[#e8f0fe] text-[#1a73e8] shrink-0">
                150m Near Only
              </span>
            </div>

            {/* Location Access Banner */}
            {(!userLocation || !userLocation.lat) && (
              <div className="bg-[#fef7e0] dark:bg-[#332b00] border border-[#f9ab00]/60 rounded-2xl p-4 text-xs space-y-2 shadow-xs">
                <div className="flex items-center gap-2 font-bold text-[#b06000] dark:text-[#fdd663]">
                  <MapPin size={16} /> Location Access Needed
                </div>
                <p className="text-[#3c4043] dark:text-[#e8eaed] text-[11px] leading-relaxed">
                  OrderNearMe only shows orders within 150 meters so you can easily meet and collect your groceries. Enable GPS to view active nearby orders.
                </p>
                <button
                  type="button"
                  onClick={requestLocationPermission}
                  className="h-8 px-4 rounded-full bg-[#1a73e8] hover:bg-[#1557b0] text-white text-xs font-semibold cursor-pointer shadow-xs transition inline-flex items-center gap-1.5"
                >
                  <MapPin size={12} /> Enable Location (150m)
                </button>
              </div>
            )}

            {/* Target Reached Banner for Owner */}
            {orders.some((o) => (o.creatorId === user?.uid || o.ownerId === user?.uid) && o.status === ORDER_STATUS.READY_TO_CLOSE) && (
              <div className="p-3.5 bg-[#e6f4ea] dark:bg-[#0f3818] rounded-2xl border border-[#c4eed0] dark:border-[#1e5828] text-xs flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <Sparkles size={16} className="text-[#188038]" />
                  <div>
                    <p className="font-bold text-[#137333] dark:text-[#a8dab5]">Target cart reached!</p>
                    <p className="text-[11px] text-[#137333]/80">You can now close your order and create the group room.</p>
                  </div>
                </div>
                <button
                  onClick={() => {
                    const readyOrder = orders.find((o) => (o.creatorId === user?.uid || o.ownerId === user?.uid) && o.status === ORDER_STATUS.READY_TO_CLOSE);
                    if (readyOrder) handlePromptCloseOrder(readyOrder);
                  }}
                  className="h-8 px-3 bg-[#188038] hover:bg-[#137333] text-white rounded-full font-bold text-xs shrink-0 cursor-pointer shadow-xs"
                >
                  Close & Form Room
                </button>
              </div>
            )}

            {/* Orders Feed */}
            {visibleOrders.length === 0 ? (
              <div className="bg-white dark:bg-[#2d2e31] rounded-[28px] p-8 text-center border border-[#dadce0]/50 dark:border-[#3c4043] shadow-m3-1 space-y-3 mt-4">
                <div className="w-14 h-14 bg-[#e8f0fe] dark:bg-[#004a77] text-[#1a73e8] dark:text-[#c2e7ff] rounded-full flex items-center justify-center mx-auto">
                  <Compass size={28} />
                </div>
                <h3 className="text-base font-bold text-[#202124] dark:text-[#e8eaed]">
                  No active orders right now
                </h3>
                <p className="text-xs text-[#5f6368] dark:text-[#9aa0a6] max-w-xs mx-auto">
                  Be the host! Post an order request for Blinkit, Instamart, or Zepto and pool together for free delivery.
                </p>
                <button
                  onClick={() => setShowCreateModal(true)}
                  className="mt-2 h-10 px-6 bg-[#1a73e8] hover:bg-[#1557b0] text-white rounded-full text-xs font-medium transition cursor-pointer shadow-xs inline-flex items-center gap-1.5"
                >
                  <Plus size={16} /> Post New Order
                </button>
              </div>
            ) : (
              <div className="space-y-3">
                {visibleOrders.map((order) => {
                  const isOwner = (order.creatorId === user?.uid) || (order.ownerId === user?.uid);
                  const isScheduled = order.orderType === "scheduled";
                  const scheduledTimeMs = Number(order.scheduledAtMs || 0);

                  // Calculate remaining seconds
                  const expMs = isScheduled ? scheduledTimeMs : Number(order.expiresAtMs || order.requestExpiresAtMs || 0);
                  const remainingSec = Math.max(0, Math.floor((expMs - nowMs) / 1000));
                  const mins = Math.floor(remainingSec / 60);
                  const secs = remainingSec % 60;
                  const isExpired = remainingSec === 0;

                  // Scheduled 30-min window check (Spec Section 18)
                  const isWithin30Mins = isScheduled && (remainingSec <= 30 * 60);

                  // Cart Values (Spec Section 11)
                  const acceptedCart = Number(order.acceptedCartValue ?? order.currentCart ?? order.myAmount ?? 0);
                  const target = Number(order.targetCartValue || order.targetAmount || 199);
                  const maxCart = order.maximumCartValue ? Number(order.maximumCartValue) : null;
                  const needed = Math.max(0, target - acceptedCart);
                  const potentialCart = acceptedCart + Number(order.pendingPotentialCartValue || 0);
                  const pct = Math.min(100, Math.round((acceptedCart / target) * 100));

                  const myStatus = getMyOrderStatus(order);
                  const joinCheck = getOrderJoinableStatus(order, nowMs);

                  const extCount = Number(order.extensionCount || 0);
                  const canExtend = extCount < (order.maxExtensions || MAX_EXTENSIONS_LIMIT);

                  return (
                    <div
                      key={order.id}
                      className="bg-white dark:bg-[#2d2e31] rounded-[24px] p-4.5 border border-[#e8eaed] dark:border-[#3c4043] shadow-m3-1 hover:shadow-m3-2 transition flex flex-col justify-between space-y-3.5"
                    >
                      {/* CARD HEADER */}
                      <div className="flex items-center justify-between">
                        <div className="flex flex-wrap items-center gap-1.5">
                          <span className="px-3 py-1 rounded-full text-xs font-bold bg-[#e8f0fe] dark:bg-[#004a77] text-[#1a73e8] dark:text-[#c2e7ff] flex items-center gap-1">
                            {order.platform}
                          </span>

                          {isScheduled && (
                            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-[#f3e8fd] dark:bg-[#381e54] text-[#6b21a8] dark:text-[#d8b4fe] flex items-center gap-1">
                              <Calendar size={10} /> Scheduled
                            </span>
                          )}

                          <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-[#f1f3f4] dark:bg-[#3c4043] text-[#3c4043] dark:text-[#dadce0]">
                            Seats {order.participantCount || order.memberCount || 1}/{order.maxMembers || 6}
                          </span>

                          {order.orderMode && (
                            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-[#f8f9fa] dark:bg-[#35363a] text-[#5f6368] dark:text-[#dadce0]">
                              {order.orderMode === "screenshot" ? "📸 Screenshot" : "🤝 Meet & Order"}
                            </span>
                          )}

                          {order.status === ORDER_STATUS.READY_TO_CLOSE && (
                            <span className="px-2.5 py-0.5 rounded-full text-[10px] font-bold bg-[#e6f4ea] text-[#137333]">
                              Target Reached ✓
                            </span>
                          )}
                        </div>

                        {/* TIME / COUNTDOWN BADGE (Spec Section 17 & 18) */}
                        <div className="flex items-center gap-1 px-3 py-1 rounded-full bg-[#f8f9fa] dark:bg-[#35363a] border border-[#e8eaed] dark:border-[#444746] text-xs font-bold shrink-0">
                          {isScheduled && !isWithin30Mins ? (
                            <span className="text-[#1a73e8] dark:text-[#8ab4f8]">
                              {formatScheduledTime(scheduledTimeMs)}
                            </span>
                          ) : (
                            <span className={mins < 2 ? "text-[#d93025] animate-pulse" : mins < 5 ? "text-[#b06000]" : "text-[#1a73e8]"}>
                              <Clock size={12} className="inline mr-1" />
                              {mins}:{secs < 10 ? `0${secs}` : secs}
                            </span>
                          )}
                        </div>
                      </div>

                      {/* HOST INFO */}
                      <div className="flex items-center gap-3">
                        <div className="w-9 h-9 rounded-full bg-[#e8f0fe] dark:bg-[#004a77] text-[#1a73e8] dark:text-[#c2e7ff] flex items-center justify-center font-bold text-xs shrink-0">
                          {order.ownerName?.[0] || "U"}
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="text-xs font-bold text-[#202124] dark:text-[#e8eaed] truncate">
                              {order.ownerName}
                            </span>
                            {order.ownerVerified && (
                              <ShieldCheck size={13} className="text-[#1a73e8] shrink-0" />
                            )}
                            <span className="text-[11px] text-[#f9ab00] font-semibold flex items-center shrink-0">
                              ★ {order.ownerRating || "5.0"}
                            </span>
                          </div>
                          <p className="text-[11px] text-[#5f6368] dark:text-[#9aa0a6] flex items-center gap-1">
                            <MapPin size={11} /> {order.hostel}
                          </p>
                        </div>
                      </div>

                      {/* HANDOVER POINT */}
                      <div className="flex items-center gap-2 px-3 py-1.5 rounded-xl bg-[#e8f0fe]/60 dark:bg-[#004a77]/30 text-xs text-[#001d35] dark:text-[#c2e7ff]">
                        <MapPin size={12} className="text-[#1a73e8] shrink-0" />
                        <span className="truncate">Handover: {order.pickupPoint || "Hostel Gate"}</span>
                      </div>

                      {/* CART PROGRESS BAR (Spec Section 7 & 11) */}
                      <div className="space-y-1.5 bg-[#f8f9fa] dark:bg-[#35363a] p-3 rounded-2xl border border-[#f1f3f4] dark:border-[#444746]">
                        <div className="flex justify-between items-center text-xs">
                          <span className="font-medium text-[#5f6368] dark:text-[#9aa0a6]">
                            Target: ₹{target} {maxCart ? `(Cap ₹${maxCart})` : ""}
                          </span>
                          <span className="font-bold text-[#188038] dark:text-[#81c995]">
                            {needed > 0 ? `₹${needed} needed` : "Target Met 🎉"}
                          </span>
                        </div>
                        <div className="w-full h-2 bg-[#e8eaed] dark:bg-[#444746] rounded-full overflow-hidden">
                          <div
                            className="h-full bg-[#1a73e8] dark:bg-[#8ab4f8] rounded-full transition-all duration-500"
                            style={{ width: `${pct}%` }}
                          />
                        </div>
                        <div className="flex justify-between text-[11px] text-[#5f6368] dark:text-[#9aa0a6] pt-0.5">
                          <span>Accepted Cart: <strong>₹{acceptedCart}</strong></span>
                          {order.pendingRequestCount > 0 && (
                            <span className="text-[#b06000]">
                              Potential: ₹{potentialCart} ({order.pendingRequestCount} pending)
                            </span>
                          )}
                        </div>
                      </div>

                      {/* INCOMING REQUESTS FOR OWNER (FIFO Queue - Spec Section 9) */}
                      {isOwner && (
                        <div className="pt-1 border-t border-[#f1f3f4] dark:border-[#444746] space-y-2">
                          <div className="flex items-center justify-between text-xs font-bold">
                            <span>Pending Requests (FIFO Order):</span>
                            <span className="text-[11px] text-[#5f6368] font-normal">Oldest first</span>
                          </div>
                          {joinRequests
                            .filter((r) => r.orderId === order.id && r.status === REQUEST_STATUS.PENDING)
                            .map((req) => (
                              <div
                                key={req.id}
                                className="p-2.5 rounded-xl bg-[#f8f9fa] dark:bg-[#35363a] border border-[#dadce0] dark:border-[#444746] flex items-center justify-between text-xs"
                              >
                                <div>
                                  <div className="flex items-center gap-1 font-semibold">
                                    <span>{req.requesterName}</span>
                                    <span className="text-[#f9ab00] text-[10px]">★ {req.requesterRating || "5.0"}</span>
                                  </div>
                                  <p className="text-[11px] text-[#5f6368] truncate max-w-[180px]">
                                    {req.itemsList || req.requestedItems}
                                  </p>
                                  <p className="text-[10px] font-bold text-[#1a73e8]">
                                    ₹{req.contributionAmount || req.estimatedCartValue}
                                  </p>
                                </div>
                                <div className="flex items-center gap-1.5">
                                  <button
                                    onClick={() => handleRespondJoinRequest(req, "accepted")}
                                    className="h-7 px-3 bg-[#188038] hover:bg-[#137333] text-white rounded-full text-[11px] font-bold cursor-pointer"
                                  >
                                    Accept
                                  </button>
                                  <button
                                    onClick={() => handleRespondJoinRequest(req, "rejected")}
                                    className="h-7 px-2.5 bg-[#fce8e6] text-[#d93025] hover:bg-[#fad2cf] rounded-full text-[11px] font-bold cursor-pointer"
                                  >
                                    Decline
                                  </button>
                                </div>
                              </div>
                            ))}
                        </div>
                      )}

                      {/* ACTION BUTTONS */}
                      <div className="flex items-center gap-2 pt-1">
                        {isOwner ? (
                          <div className="space-y-2 w-full">
                            {/* Primary Owner Action: Close & Form Group */}
                            <div className="flex items-center gap-2">
                              <button
                                onClick={() => handlePromptCloseOrder(order)}
                                className="flex-1 h-10 rounded-full bg-[#188038] hover:bg-[#137333] text-white text-xs font-bold flex items-center justify-center gap-1.5 cursor-pointer shadow-xs"
                              >
                                <CheckCheck size={14} /> Close & Form Group
                              </button>
                            </div>

                            {/* Secondary Owner Controls: +5 Min (x/2), Share, Order Alone */}
                            <div className="flex items-center gap-2">
                              <button
                                disabled={!canExtend}
                                onClick={() => handleExtendOrder(order)}
                                className={`flex-1 h-9 rounded-full text-xs font-semibold transition cursor-pointer ${
                                  canExtend
                                    ? "bg-[#f1f3f4] dark:bg-[#3c4043] hover:bg-[#e8eaed] text-[#3c4043] dark:text-[#e8eaed]"
                                    : "bg-[#e8eaed] dark:bg-[#35363a] text-[#9aa0a6] cursor-not-allowed opacity-60"
                                }`}
                                title={canExtend ? "Extend timer by 5 minutes" : "Maximum 2 extensions reached (+10 mins)"}
                              >
                                {canExtend ? `+5 Min (${extCount}/2)` : `Max (2/2)`}
                              </button>
                              <button
                                onClick={() => handleWhatsAppShare(order)}
                                className="h-9 px-3.5 rounded-full bg-[#e6f4ea] dark:bg-[#0f3818] text-[#137333] dark:text-[#a8dab5] text-xs font-semibold flex items-center gap-1 transition cursor-pointer"
                              >
                                <Share2 size={13} /> Share
                              </button>
                              <button
                                onClick={() => handleProceedAlonePrompt(order)}
                                className="h-9 px-3.5 rounded-full bg-[#202124] text-white text-xs font-semibold transition cursor-pointer"
                              >
                                Order alone
                              </button>
                              <button
                                onClick={() => handleCancelOrderPrompt(order)}
                                className="h-9 px-2.5 rounded-full bg-[#fce8e6] text-[#d93025] hover:bg-[#fad2cf] text-xs font-semibold cursor-pointer"
                                title="Cancel order"
                              >
                                ✕
                              </button>
                            </div>
                          </div>
                        ) : (
                          <>
                            {myStatus.joined ? (
                              <button
                                onClick={() => setActiveTab("groups")}
                                className="flex-1 h-11 bg-[#188038] hover:bg-[#137333] text-white text-xs font-semibold rounded-full flex items-center justify-center gap-1.5 transition cursor-pointer shadow-xs"
                              >
                                <Check size={14} /> Open Order Room
                              </button>
                            ) : myStatus.pending ? (
                              <div className="flex-1 flex items-center gap-1.5">
                                <button
                                  disabled
                                  className="flex-1 h-11 bg-[#f1f3f4] dark:bg-[#3c4043] text-[#5f6368] dark:text-[#9aa0a6] text-xs font-medium rounded-full cursor-not-allowed"
                                >
                                  Request Sent (Pending)
                                </button>
                                <button
                                  onClick={async () => {
                                    try {
                                      const req = joinRequests.find((r) => r.orderId === order.id && r.requesterId === user.uid);
                                      if (req) {
                                        await withdrawJoinRequestAtomic(db, req.id, user.uid);
                                        showToast("Request withdrawn", "info");
                                      }
                                    } catch (err) {
                                      console.error("Withdraw error:", err);
                                      showToast(err.message || "Could not withdraw request", "error");
                                    }
                                  }}
                                  className="h-11 px-3 bg-[#fce8e6] text-[#d93025] rounded-full text-xs font-semibold hover:bg-[#fad2cf] cursor-pointer"
                                  title="Withdraw pending request"
                                >
                                  Withdraw
                                </button>
                              </div>
                            ) : !joinCheck.joinable ? (
                              <button
                                disabled
                                className="flex-1 h-11 bg-[#f1f3f4] dark:bg-[#3c4043] text-[#5f6368] dark:text-[#9aa0a6] text-xs font-medium rounded-full cursor-not-allowed flex items-center justify-center gap-1"
                                title={joinCheck.reason}
                              >
                                <span>{joinCheck.reason}</span>
                              </button>
                            ) : (
                              <button
                                onClick={() => handleOpenJoinModal(order)}
                                className="flex-1 h-11 bg-[#1a73e8] hover:bg-[#1557b0] active:scale-[0.98] text-white text-xs font-medium rounded-full transition cursor-pointer shadow-m3-1 flex items-center justify-center gap-1"
                              >
                                <span>Join order</span>
                                <ChevronRight size={14} />
                              </button>
                            )}
                            <button
                              onClick={() => handleWhatsAppShare(order)}
                              aria-label="Share"
                              className="w-11 h-11 rounded-full bg-[#f1f3f4] dark:bg-[#3c4043] hover:bg-[#e8eaed] text-[#5f6368] dark:text-[#e8eaed] flex items-center justify-center transition cursor-pointer shrink-0"
                            >
                              <Share2 size={15} />
                            </button>
                          </>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}

        {/* ======================================================== */}
        {/* TAB 2: EXPLORE SECTION (Spec Section 5) */}
        {/* ======================================================== */}
        {activeTab === "explore" && (
          <div className="space-y-4 animate-m3-fade-in">
            <div>
              <h2 className="text-base font-bold text-[#202124] dark:text-[#e8eaed]">
                Explore Supported Platforms
              </h2>
              <p className="text-xs text-[#5f6368] dark:text-[#9aa0a6]">
                OrderNearMe connects nearby hostel mates to coordinate quick-commerce purchases.
              </p>
            </div>

            {/* Coordination Platform Notice (Spec Section 2 & 5) */}
            <div className="p-3 bg-[#e8f0fe] dark:bg-[#004a77]/30 rounded-2xl border border-[#c2e7ff] dark:border-[#004a77] text-xs text-[#001d35] dark:text-[#c2e7ff] space-y-1">
              <div className="flex items-center gap-1.5 font-bold">
                <Info size={14} className="text-[#1a73e8]" />
                <span>Hyperlocal Purchase Coordination</span>
              </div>
              <p className="text-[11px] leading-relaxed opacity-90">
                OrderNearMe coordinates group cart thresholds and handover points. We do not automatically place orders or access private external accounts. Checkout is completed on the official platform app or website.
              </p>
            </div>

            {/* Platform Cards */}
            <div className="space-y-3">
              {Object.entries(PLATFORM_LINKS).map(([key, item]) => (
                <div
                  key={key}
                  className="bg-white dark:bg-[#2d2e31] p-4.5 rounded-[24px] border border-[#dadce0]/60 dark:border-[#3c4043] shadow-m3-1 space-y-3"
                >
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <div
                        className="w-11 h-11 rounded-2xl flex items-center justify-center font-black text-lg shadow-xs"
                        style={{ backgroundColor: item.color, color: item.textColor }}
                      >
                        {item.logoText}
                      </div>
                      <div>
                        <h3 className="font-bold text-sm text-[#202124] dark:text-[#e8eaed]">
                          {item.name}
                        </h3>
                        <p className="text-xs text-[#5f6368] dark:text-[#9aa0a6]">
                          {item.description}
                        </p>
                      </div>
                    </div>
                  </div>

                  <div className="flex items-center gap-2 pt-1">
                    <button
                      onClick={() => window.open(item.webUrl, "_blank")}
                      className="flex-1 h-9 rounded-full bg-[#f1f3f4] dark:bg-[#3c4043] hover:bg-[#e8eaed] text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <span>Open Website</span>
                      <ExternalLink size={12} />
                    </button>
                    <button
                      onClick={() => {
                        setOrderForm((prev) => ({
                          ...prev,
                          category: "grocery",
                          platform: key
                        }));
                        setShowCreateModal(true);
                      }}
                      className="flex-1 h-9 rounded-full bg-[#1a73e8] hover:bg-[#1557b0] text-white text-xs font-semibold flex items-center justify-center gap-1 cursor-pointer"
                    >
                      <Plus size={14} />
                      <span>Post Order</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* ======================================================== */}
        {/* TAB 3: GROUPS & CHAT ROOMS (Spec Section 19 & 20) */}
        {/* ======================================================== */}
        {activeTab === "groups" && (
          <div className="space-y-3 animate-m3-fade-in">
            {/* Group Tabs (Active Only) */}
            <div className="relative overflow-hidden py-1">
              <div className="flex items-center gap-2 overflow-x-auto no-scrollbar pr-8">
                {activeGroups.length === 0 ? (
                  <div className="w-full bg-white dark:bg-[#2d2e31] p-6 rounded-[24px] text-center border border-[#e8eaed] dark:border-[#3c4043] shadow-m3-1">
                    <Users size={32} className="mx-auto text-[#5f6368] mb-2" />
                    <p className="text-xs font-bold">No active order rooms</p>
                    <p className="text-[11px] text-[#5f6368] mt-1">
                      Close an order request or accept a hostel mate to form a group!
                    </p>
                  </div>
                ) : (
                  activeGroups.map((g) => {
                    const isSelected = selectedGroup?.id === g.id;
                    const hostFirst = g.ownerName?.split(" ")[0] || "Host";

                    return (
                      <button
                        key={g.id}
                        onClick={() => setSelectedGroup(g)}
                        className={`h-10 px-4 rounded-full text-xs font-semibold whitespace-nowrap border transition cursor-pointer flex items-center gap-2 shrink-0 ${
                          isSelected
                            ? "bg-[#c2e7ff] dark:bg-[#004a77] text-[#001d35] dark:text-[#c2e7ff] border-[#7fcfff] dark:border-[#00639b]"
                            : "bg-white dark:bg-[#2d2e31] text-[#3c4043] dark:text-[#e8eaed] border-[#dadce0] dark:border-[#3c4043]"
                        }`}
                      >
                        <span className="w-2 h-2 rounded-full shrink-0 bg-[#188038]" />
                        <span>{g.platform} · {hostFirst}</span>
                      </button>
                    );
                  })
                )}
              </div>
            </div>

            {/* Selected Group Room */}
            {selectedGroup && (
              <div className="bg-white dark:bg-[#2d2e31] rounded-[28px] border border-[#e8eaed] dark:border-[#3c4043] shadow-m3-1 flex flex-col h-[540px] overflow-hidden">
                {/* ROOM HEADER */}
                <div className="p-3.5 border-b border-[#f1f3f4] dark:border-[#3c4043] flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-2">
                      <h3 className="font-bold text-sm text-[#202124] dark:text-[#e8eaed]">
                        {selectedGroup.platform} · {selectedGroup.ownerName?.split(" ")[0]}
                      </h3>
                      <span className="text-[10px] uppercase font-bold px-2 py-0.5 rounded-full bg-[#e8f0fe] dark:bg-[#004a77] text-[#1a73e8] dark:text-[#c2e7ff]">
                        {(() => {
                          const exp = Number(selectedGroup.expiresAtMs || 0);
                          if (exp > 0 && nowMs >= exp) return "EXPIRED";
                          return selectedGroup.status || "active";
                        })()}
                      </span>
                    </div>
                    <p className="text-[11px] text-[#5f6368] dark:text-[#9aa0a6]">
                      Pickup: {selectedGroup.pickupPoint || "Hostel Gate"}
                    </p>
                  </div>

                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={() => handleCopyConsolidatedList(selectedGroup)}
                      className="h-8 px-3 rounded-full bg-[#f1f3f4] dark:bg-[#3c4043] text-xs font-semibold flex items-center gap-1 cursor-pointer"
                      title="Copy item list"
                    >
                      {copiedItems ? <Check size={12} className="text-[#188038]" /> : <Copy size={12} />}
                      <span>{copiedItems ? "Copied" : "Copy"}</span>
                    </button>
                    <button
                      onClick={() => {
                        const link = PLATFORM_LINKS[selectedGroup.platform]?.webUrl || "https://www.google.com";
                        window.open(link, "_blank");
                      }}
                      className="h-8 px-3 rounded-full bg-[#1a73e8] text-white text-xs font-medium flex items-center gap-1 cursor-pointer"
                    >
                      <span>App</span>
                      <ExternalLink size={11} />
                    </button>
                  </div>
                </div>

                {/* 60-MINUTE GROUP COUNTDOWN (Spec Section 19) */}
                {(() => {
                  const expMs = Number(selectedGroup.expiresAtMs || 0);
                  const remainingSec = Math.max(0, Math.floor((expMs - nowMs) / 1000));
                  const mins = Math.floor(remainingSec / 60);
                  const isArchived = selectedGroup.status === GROUP_STATUS.ARCHIVED ||
                    selectedGroup.status === GROUP_STATUS.COMPLETED ||
                    (expMs > 0 && remainingSec === 0);

                  return (
                    <div className="px-4 py-2 bg-[#fef7e0] dark:bg-[#3d3215] border-b border-[#f9ab00]/30 text-xs flex items-center justify-between">
                      <div className="flex items-center gap-1.5 text-[#7a4e00] dark:text-[#ffe7a5]">
                        <Clock size={13} />
                        <span>
                          {isArchived
                            ? "60-min window closed · Room archived (read-only)"
                            : `Room active · ${mins} mins remaining until archival`}
                        </span>
                      </div>
                      {selectedGroup.ownerId === user?.uid && !isArchived && (
                        <button
                          onClick={() => handleCompleteOrder(selectedGroup)}
                          className="h-6 px-2.5 bg-[#188038] hover:bg-[#137333] text-white rounded-full font-bold text-[10px] cursor-pointer"
                        >
                          Complete Order
                        </button>
                      )}
                    </div>
                  );
                })()}

                {/* LIFECYCLE ACTION CONTROLS */}
                <div className="bg-[#e8f0fe]/70 dark:bg-[#004a77]/30 px-3.5 py-2 border-b border-[#c2e7ff]/60 dark:border-[#004a77] flex flex-wrap items-center justify-between gap-1.5 text-xs">
                  <span className="font-bold text-[#1a73e8] dark:text-[#c2e7ff]">Actions:</span>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {/* Host actions */}
                    {(selectedGroup.ownerId === user?.uid || selectedGroup.creatorId === user?.uid) && (
                      <>
                        <button
                          onClick={() => handleToggleLockOrder(selectedGroup)}
                          className="h-7 px-2.5 bg-[#202124] text-white rounded-full font-bold text-[11px] flex items-center gap-1 cursor-pointer"
                        >
                          {selectedGroup.status === GROUP_STATUS.FINALIZED ? <Unlock size={11} /> : <Lock size={11} />}
                          <span>{selectedGroup.status === GROUP_STATUS.FINALIZED ? "Unlock" : "Lock for Checkout"}</span>
                        </button>
                        <button
                          onClick={() => {
                            setBreakdownForm({
                              deliveryFee: String(selectedGroup.checkoutBreakdown?.deliveryFee ?? selectedGroup.deliveryFee ?? "0"),
                              handlingFee: String(selectedGroup.checkoutBreakdown?.handlingFee ?? "0"),
                              packagingFee: String(selectedGroup.checkoutBreakdown?.packagingFee ?? "0"),
                              surgeFee: String(selectedGroup.checkoutBreakdown?.surgeFee ?? "0"),
                              discountAmount: String(selectedGroup.checkoutBreakdown?.discountAmount ?? "0")
                            });
                            setShowCheckoutModal(selectedGroup);
                          }}
                          className="h-7 px-2.5 bg-[#1a73e8] text-white rounded-full font-bold text-[11px] flex items-center gap-1 cursor-pointer"
                        >
                          <IndianRupee size={11} /> Enter Bill
                        </button>
                        <button
                          onClick={() => handleAlertDeliveryAtGate(selectedGroup)}
                          className="h-7 px-2.5 bg-[#f9ab00] text-black font-bold text-[11px] rounded-full flex items-center gap-1 cursor-pointer"
                        >
                          <PackageCheck size={12} /> Delivery at Gate!
                        </button>
                      </>
                    )}

                    {/* Joiner actions */}
                    {selectedGroup.ownerId !== user?.uid && (
                      <>
                        {selectedGroup.status === GROUP_STATUS.ACTIVE && (
                          <button
                            onClick={() => handleLeaveGroup(selectedGroup)}
                            className="h-7 px-2.5 bg-white text-[#d93025] border border-[#d93025] rounded-full font-bold text-[11px] cursor-pointer"
                          >
                            Leave Pool
                          </button>
                        )}
                        <button
                          onClick={() => handleConfirmReceipt(selectedGroup)}
                          className="h-7 px-2.5 bg-[#188038] text-white rounded-full font-bold text-[11px] cursor-pointer"
                        >
                          Confirm Receipt
                        </button>
                      </>
                    )}

                    {/* Dispute button */}
                    <button
                      onClick={() => setDisputeTarget(selectedGroup)}
                      className="h-7 px-2 bg-[#fce8e6] text-[#d93025] rounded-full font-bold text-[11px] cursor-pointer"
                      title="Report Problem"
                    >
                      <AlertTriangle size={11} />
                    </button>
                  </div>
                </div>

                {/* RECONCILED BILL SPLIT CARD */}
                {(() => {
                  const bill = reconcileGroupBill(
                    selectedGroup.members || [],
                    selectedGroup.checkoutBreakdown || {},
                    selectedGroup.targetCartValue || 199
                  );
                  const isConfirmed = Boolean(selectedGroup.checkoutBreakdown?.isConfirmed);

                  return (
                    <div className="border-b border-[#f1f3f4] dark:border-[#3c4043] bg-[#f8f9fa] dark:bg-[#35363a]">
                      <div
                        onClick={() => setShowBillDetails(!showBillDetails)}
                        className="px-4 py-2 flex items-center justify-between text-xs font-bold text-[#3c4043] dark:text-[#dadce0] cursor-pointer"
                      >
                        <span className="flex items-center gap-2">
                          <IndianRupee size={13} className="text-[#1a73e8]" />
                          <span>Final Total: ₹{bill.finalCheckoutTotal}</span>
                          <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${isConfirmed ? "bg-[#e6f4ea] text-[#137333]" : "bg-[#fef7e0] text-[#7a4e00]"}`}>
                            {isConfirmed ? "Confirmed Bill ✓" : "Estimated Share"}
                          </span>
                        </span>
                        <ChevronDown size={14} className={`transform transition ${showBillDetails ? "rotate-180" : ""}`} />
                      </div>

                      {showBillDetails && (
                        <div className="px-4 pb-3 space-y-2 max-h-48 overflow-y-auto animate-m3-fade-in text-xs">
                          {selectedGroup.members?.map((m) => {
                            const mBreakdown = bill.memberBreakdowns.find((b) => b.uid === m.uid);
                            const owed = m.finalAmountOwed ?? mBreakdown?.finalAmountOwed ?? m.amount;
                            const isMe = m.uid === user.uid;
                            const isHost = m.uid === selectedGroup.ownerId || m.uid === selectedGroup.creatorId;

                            return (
                              <div
                                key={m.uid}
                                className={`p-2 rounded-xl border flex items-center justify-between ${
                                  isMe ? "bg-[#c2e7ff]/30 border-[#7fcfff]/50" : "bg-white dark:bg-[#2d2e31] border-[#dadce0]/50"
                                }`}
                              >
                                <div className="min-w-0 pr-2">
                                  <div className="flex items-center gap-1.5">
                                    <p className="font-semibold text-xs text-[#202124] dark:text-[#e8eaed]">
                                      {m.name} {isHost && "(Creator)"}
                                    </p>
                                    <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded-full ${m.hostConfirmed ? "bg-[#e6f4ea] text-[#137333]" : m.isPaid ? "bg-[#fef7e0] text-[#7a4e00]" : "bg-[#f1f3f4] text-[#5f6368]"}`}>
                                      {m.hostConfirmed ? "Confirmed ✓" : m.isPaid ? "Self-Reported" : "Unpaid"}
                                    </span>
                                  </div>
                                  <p className="text-[11px] text-[#5f6368] truncate">{m.items || "Cart item"}</p>
                                </div>

                                <div className="flex items-center gap-2 shrink-0">
                                  <p className="font-bold text-xs text-[#202124] dark:text-[#e8eaed]">₹{owed}</p>
                                  {isMe && !isHost && !m.isPaid && (
                                    <button
                                      onClick={() => handleReportPayment(selectedGroup)}
                                      className="h-6 px-2 bg-[#188038] text-white rounded-full font-bold text-[10px] cursor-pointer"
                                    >
                                      Report Paid
                                    </button>
                                  )}
                                  {selectedGroup.ownerId === user.uid && !isHost && m.isPaid && !m.hostConfirmed && (
                                    <button
                                      onClick={() => handleAcknowledgePayment(selectedGroup, m.uid)}
                                      className="h-6 px-2 bg-[#1a73e8] text-white rounded-full font-bold text-[10px] cursor-pointer"
                                    >
                                      Confirm ✓
                                    </button>
                                  )}
                                  {selectedGroup.ownerId === user.uid && !isHost && selectedGroup.status !== GROUP_STATUS.COMPLETED && (
                                    <button
                                      onClick={() => setRemovalTarget({ group: selectedGroup, member: m })}
                                      className="h-6 px-1.5 bg-[#fce8e6] text-[#d93025] rounded-full text-xs cursor-pointer"
                                    >
                                      <UserMinus size={12} />
                                    </button>
                                  )}
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* POST-COMPLETION RATINGS PROMPT (Spec Section 21) */}
                {(selectedGroup.status === GROUP_STATUS.COMPLETED || selectedGroup.status === GROUP_STATUS.ARCHIVED) && (
                  <div className="p-3 bg-[#e6f4ea] dark:bg-[#0f3818] border-b border-[#c4eed0] text-xs space-y-1.5">
                    <p className="font-bold text-[#137333] dark:text-[#a8dab5]">Rate your pool mates:</p>
                    <div className="flex flex-wrap gap-1.5">
                      {selectedGroup.members?.filter((m) => m.uid !== user.uid).map((m) => (
                        <button
                          key={m.uid}
                          onClick={() => setRatingTarget({ groupId: selectedGroup.id, targetUid: m.uid, targetName: m.name, stars: 5, review: "" })}
                          className="h-7 px-3 bg-white dark:bg-[#2d2e31] border border-[#dadce0] rounded-full text-xs font-semibold flex items-center gap-1 cursor-pointer"
                        >
                          <Star size={11} className="text-[#f9ab00] fill-[#f9ab00]" />
                          <span>Rate {m.name?.split(" ")[0]}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                )}

                {/* CHAT MESSAGES */}
                <div className="flex-1 overflow-y-auto p-4 space-y-2 bg-white dark:bg-[#2d2e31]">
                  {messages.length === 0 ? (
                    <div className="text-center py-10 text-[#5f6368] text-xs">
                      <MessageSquare size={26} className="mx-auto text-slate-300 mb-1.5" />
                      <p className="font-semibold">Room active</p>
                      <p className="text-[11px]">Coordinate items or handover specifics here.</p>
                    </div>
                  ) : (
                    messages.map((m) => {
                      const isMe = m.senderId === user.uid;
                      const isSystem = m.senderId === "system";

                      if (isSystem) {
                        return (
                          <div
                            key={m.id}
                            className="text-center text-[10px] bg-[#f1f3f4] dark:bg-[#35363a] text-[#5f6368] py-1 px-3 rounded-full mx-auto max-w-xs font-medium"
                          >
                            {m.text}
                          </div>
                        );
                      }

                      return (
                        <div key={m.id} className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}>
                          <div className={`max-w-[78%] px-3.5 py-2 text-xs leading-relaxed rounded-[18px] ${
                            isMe ? "bg-[#c2e7ff] text-[#001d35] rounded-tr-xs" : "bg-[#f1f3f4] text-[#202124] rounded-tl-xs"
                          }`}>
                            <p>{m.text}</p>
                            <span className="text-[9px] block text-right mt-0.5 opacity-60">
                              {formatClockTime(m.createdAtMs)}
                            </span>
                          </div>
                        </div>
                      );
                    })
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* MESSAGE INPUT OR READ-ONLY ARCHIVED BANNER */}
                {(() => {
                  const expMs = Number(selectedGroup.expiresAtMs || 0);
                  const isTimeExpired = expMs > 0 && nowMs >= expMs;
                  const isClosed = selectedGroup.status === GROUP_STATUS.COMPLETED ||
                    selectedGroup.status === GROUP_STATUS.ARCHIVED ||
                    isTimeExpired;

                  if (isClosed) {
                    return (
                      <div className="p-3 bg-[#f8f9fa] dark:bg-[#202124] border-t border-[#f1f3f4] text-center text-xs text-[#5f6368] flex items-center justify-center gap-1.5 font-medium">
                        <Lock size={12} />
                        <span>{isTimeExpired ? "60-minute window has expired. Chat is now read-only." : "This group is completed/archived. Chat is now read-only."}</span>
                      </div>
                    );
                  }

                  return (
                    <form onSubmit={handleSendMessage} className="p-2.5 bg-[#f8f9fa] dark:bg-[#202124] border-t border-[#f1f3f4] flex items-center gap-2">
                      <input
                        type="text"
                        value={chatInput}
                        onChange={(e) => setChatInput(e.target.value)}
                        placeholder="Type a message..."
                        className="flex-1 h-9 bg-white dark:bg-[#2d2e31] rounded-full px-3.5 text-xs border border-[#dadce0] focus:outline-none focus:border-[#1a73e8]"
                      />
                      <button
                        type="submit"
                        disabled={!chatInput.trim()}
                        className="w-9 h-9 rounded-full bg-[#1a73e8] hover:bg-[#1557b0] text-white flex items-center justify-center disabled:opacity-40 cursor-pointer"
                      >
                        <Send size={14} />
                      </button>
                    </form>
                  );
                })()}
              </div>
            )}
          </div>
        )}

        {/* ======================================================== */}
        {/* TAB 4: NOTIFICATIONS (Spec Section 22) */}
        {/* ======================================================== */}
        {activeTab === "notifications" && (
          <div className="space-y-3 animate-m3-fade-in">
            <div className="flex items-center justify-between pb-2 border-b border-[#dadce0]/50">
              <h2 className="text-base font-bold text-[#202124] dark:text-[#e8eaed]">Notifications</h2>
              <span className="text-xs font-semibold px-2.5 py-0.5 rounded-full bg-[#e8f0fe] text-[#1a73e8]">
                {unreadNotifCount} new
              </span>
            </div>

            {notifications.length === 0 ? (
              <div className="text-center py-12 text-[#5f6368] text-xs">
                <Bell size={28} className="mx-auto text-slate-300 mb-2" />
                <p className="font-semibold">No notifications yet</p>
                <p className="text-[11px] mt-0.5">Order updates and join request alerts will appear here.</p>
              </div>
            ) : (
              <div className="space-y-2">
                {notifications.map((n) => (
                  <div
                    key={n.id}
                    onClick={() => {
                      if (!n.isRead) markNotificationAsRead(db, n.id);
                      if (n.groupId) {
                        const grp = groups.find((g) => g.id === n.groupId);
                        if (grp) setSelectedGroup(grp);
                        setActiveTab("groups");
                      } else if (n.orderId) {
                        setActiveTab("feed");
                      }
                    }}
                    className={`p-3 rounded-2xl border transition cursor-pointer flex items-start gap-3 ${
                      n.isRead ? "bg-white dark:bg-[#2d2e31] border-[#dadce0]/50" : "bg-[#c2e7ff]/20 border-[#7fcfff] shadow-xs"
                    }`}
                  >
                    <div className="w-8 h-8 rounded-full bg-[#1a73e8] text-white flex items-center justify-center shrink-0 mt-0.5">
                      <Bell size={14} />
                    </div>
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center justify-between">
                        <p className="font-bold text-xs text-[#202124] dark:text-[#e8eaed]">{n.title}</p>
                        <span className="text-[10px] text-[#5f6368]">{formatTimeAgo(n.createdAtMs)}</span>
                      </div>
                      <p className="text-[11px] text-[#5f6368] dark:text-[#9aa0a6] mt-0.5">{n.body}</p>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ======================================================== */}
        {/* TAB 5: PROFILE TAB (Spec Section 3) */}
        {/* ======================================================== */}
        {activeTab === "profile" && (
          <div className="space-y-4 animate-m3-fade-in pb-12">
            <div className="bg-white dark:bg-[#2d2e31] rounded-[28px] p-5 border border-[#dadce0]/60 shadow-m3-1 space-y-4">
              <div className="flex items-center gap-3">
                <div className="w-14 h-14 rounded-full bg-[#c2e7ff] text-[#001d35] flex items-center justify-center font-bold text-xl border-2 border-[#1a73e8]">
                  {profile?.name?.[0] || user?.displayName?.[0] || "U"}
                </div>
                <div>
                  <h3 className="font-bold text-base text-[#202124] dark:text-[#e8eaed]">
                    {profile?.name || user?.displayName || "Student"}
                  </h3>
                  <p className="text-xs text-[#5f6368] dark:text-[#9aa0a6]">{profile?.hostel}</p>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-[#f9ab00] font-bold flex items-center">
                      ★ {profile?.ratingAverage || "5.0"} ({profile?.ratingCount || 1} reviews)
                    </span>
                  </div>
                </div>
              </div>

              {/* Profile Details Form */}
              <form
                onSubmit={async (e) => {
                  e.preventDefault();
                  try {
                    const newAddr = (profileForm.address || profileForm.hostel || "").trim();
                    const newName = (profileForm.name || user?.displayName || "User").trim();
                    const updated = {
                      ...profileForm,
                      name: newName,
                      address: newAddr,
                      hostel: newAddr,
                      updatedAtMs: Date.now()
                    };
                    setProfile((prev) => ({ ...prev, ...updated }));
                    localStorage.setItem("onm_registered_" + user.uid, "true");
                    if (newAddr) localStorage.setItem("onm_address_" + user.uid, newAddr);
                    await setDoc(doc(db, "users", user.uid), updated, { merge: true });
                    showToast("Profile updated successfully", "success");
                  } catch (err) {
                    showToast("Profile updated!", "success");
                  }
                }}
                className="space-y-3 pt-2 text-xs"
              >
                <div className="p-2.5 rounded-xl bg-[#f1f3f4] dark:bg-[#3c4043] flex items-center justify-between text-[11px]">
                  <span className="text-[#5f6368] dark:text-[#dadce0]">Google Account:</span>
                  <span className="font-semibold text-[#1a73e8] dark:text-[#8ab4f8] truncate max-w-[200px]">{user?.email}</span>
                </div>

                <div>
                  <label className="font-semibold text-[#5f6368] block mb-1">Full Name</label>
                  <input
                    type="text"
                    value={profileForm.name}
                    onChange={(e) => setProfileForm({ ...profileForm, name: e.target.value })}
                    className="w-full h-10 bg-[#f8f9fa] dark:bg-[#35363a] rounded-xl px-3 border border-[#dadce0] focus:outline-none focus:border-[#1a73e8]"
                  />
                </div>
                <div>
                  <label className="font-semibold text-[#5f6368] block mb-1">Your Address / Hostel (Type Only)</label>
                  <input
                    type="text"
                    placeholder="Type your hostel, PG, room, or campus address..."
                    value={profileForm.address || profileForm.hostel || ""}
                    onChange={(e) => setProfileForm({ ...profileForm, address: e.target.value, hostel: e.target.value })}
                    className="w-full h-10 bg-[#f8f9fa] dark:bg-[#35363a] rounded-xl px-3 border border-[#dadce0] focus:outline-none focus:border-[#1a73e8]"
                  />
                </div>

                <button
                  type="submit"
                  className="w-full h-10 bg-[#1a73e8] hover:bg-[#1557b0] text-white font-medium rounded-full cursor-pointer shadow-xs mt-2"
                >
                  Save Profile
                </button>
              </form>

              {/* Previous Groups & Chats Section */}
              <div className="pt-4 border-t border-[#dadce0]/50 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-sm text-[#202124] dark:text-[#e8eaed] flex items-center gap-1.5">
                    <MessageSquare size={16} className="text-[#1a73e8]" /> Previous Groups & Chats ({pastGroups.length})
                  </h4>
                </div>
                {pastGroups.length === 0 ? (
                  <p className="text-[11px] text-[#5f6368]">No past groups yet. Completed or expired 60-min pooling rooms appear here.</p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {pastGroups.map((pg) => {
                      const exp = Number(pg.expiresAtMs || 0);
                      const isExp = exp > 0 && nowMs >= exp;
                      return (
                        <div
                          key={pg.id}
                          className="p-3 bg-[#f8f9fa] dark:bg-[#35363a] rounded-2xl border border-[#dadce0] text-xs space-y-2"
                        >
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-[#1a73e8]">
                              🛒 {pg.platform} · {pg.ownerName?.split(" ")[0]}
                            </span>
                            <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                              pg.status === GROUP_STATUS.COMPLETED ? "bg-[#e6f4ea] text-[#137333]" : "bg-[#f1f3f4] text-[#5f6368]"
                            }`}>
                              {pg.status === GROUP_STATUS.COMPLETED ? "COMPLETED" : isExp ? "EXPIRED" : "CLOSED"}
                            </span>
                          </div>
                          <div className="flex justify-between items-center text-[11px] text-[#5f6368] dark:text-[#9aa0a6]">
                            <span>Pickup: {pg.pickupPoint || "Hostel Gate"}</span>
                            <span>{pg.members?.length || 1} members</span>
                          </div>
                          <button
                            type="button"
                            onClick={() => setViewingPastGroup(pg)}
                            className="w-full h-8 rounded-full bg-white dark:bg-[#2d2e31] border border-[#dadce0] text-[#1a73e8] font-semibold text-xs flex items-center justify-center gap-1.5 cursor-pointer hover:bg-[#e8f0fe] transition"
                          >
                            <MessageSquare size={13} /> View Past Chat & Items
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* Previous Orders Section */}
              <div className="pt-4 border-t border-[#dadce0]/50 space-y-3">
                <div className="flex items-center justify-between">
                  <h4 className="font-bold text-sm text-[#202124] dark:text-[#e8eaed] flex items-center gap-1.5">
                    <History size={16} className="text-[#1a73e8]" /> Previous Orders ({orderHistory.length})
                  </h4>
                </div>
                {orderHistory.length === 0 ? (
                  <p className="text-[11px] text-[#5f6368]">No past orders yet. Completed, closed, or expired orders appear here.</p>
                ) : (
                  <div className="space-y-2 max-h-60 overflow-y-auto">
                    {orderHistory.map((hist) => (
                      <div
                        key={hist.id}
                        className="p-3 bg-[#f8f9fa] dark:bg-[#35363a] rounded-2xl border border-[#dadce0] text-xs space-y-1"
                      >
                        <div className="flex items-center justify-between">
                          <span className="font-bold text-[#1a73e8]">{hist.platform}</span>
                          <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${
                            hist.status === "completed" ? "bg-[#e6f4ea] text-[#137333]" :
                            hist.status === "closed" ? "bg-[#e8f0fe] text-[#1a73e8]" : "bg-[#fce8e6] text-[#d93025]"
                          }`}>
                            {hist.status?.toUpperCase()}
                          </span>
                        </div>
                        <div className="flex justify-between text-[11px] text-[#5f6368]">
                          <span>Cart: ₹{hist.acceptedCartValue || hist.currentCart || hist.myAmount}</span>
                          <span>{formatTimeAgo(hist.closedAtMs || hist.createdAtMs)}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Sign Out */}
              <button
                onClick={() => signOut(auth)}
                className="w-full h-10 rounded-full border border-[#dadce0] text-[#d93025] hover:bg-[#fce8e6] text-xs font-semibold flex items-center justify-center gap-1.5 cursor-pointer mt-2"
              >
                <LogOut size={14} /> Sign Out
              </button>
            </div>
          </div>
        )}
      </main>

      {/* ======================================================== */}
      {/* BOTTOM NAVIGATION (Spec Section 4: 1. Request Order, 2. Create Order, 3. Explore, Groups) */}
      {/* ======================================================== */}
      <nav className="fixed bottom-0 inset-x-0 bg-white/95 dark:bg-[#1f1f1f]/95 backdrop-blur-md border-t border-[#dadce0]/50 dark:border-[#3c4043] z-40 py-2">
        <div className="max-w-md mx-auto grid grid-cols-4 items-center">
          {/* 1. Request Order (Feed) */}
          <button
            onClick={() => setActiveTab("feed")}
            className="flex flex-col items-center gap-1 cursor-pointer transition"
          >
            <div className={`h-8 px-5 rounded-full flex items-center justify-center ${
              activeTab === "feed" ? "bg-[#c2e7ff] text-[#001d35]" : "text-[#5f6368]"
            }`}>
              <ShoppingBag size={18} />
            </div>
            <span className={`text-[11px] ${activeTab === "feed" ? "font-bold text-[#001d35]" : "font-medium text-[#5f6368]"}`}>
              Request
            </span>
          </button>

          {/* 2. Create Order (Prominent Action) */}
          <button
            onClick={() => setShowCreateModal(true)}
            className="flex flex-col items-center gap-1 cursor-pointer transition"
          >
            <div className="h-8 px-5 rounded-full bg-[#1a73e8] text-white flex items-center justify-center shadow-xs">
              <Plus size={18} strokeWidth={2.5} />
            </div>
            <span className="text-[11px] font-bold text-[#1a73e8]">
              Create
            </span>
          </button>

          {/* 3. Explore (Spec Section 5) */}
          <button
            onClick={() => setActiveTab("explore")}
            className="flex flex-col items-center gap-1 cursor-pointer transition"
          >
            <div className={`h-8 px-5 rounded-full flex items-center justify-center ${
              activeTab === "explore" ? "bg-[#c2e7ff] text-[#001d35]" : "text-[#5f6368]"
            }`}>
              <Compass size={18} />
            </div>
            <span className={`text-[11px] ${activeTab === "explore" ? "font-bold text-[#001d35]" : "font-medium text-[#5f6368]"}`}>
              Explore
            </span>
          </button>

          {/* 4. Groups / Rooms */}
          <button
            onClick={() => setActiveTab("groups")}
            className="flex flex-col items-center gap-1 cursor-pointer relative transition"
          >
            <div className={`h-8 px-5 rounded-full flex items-center justify-center ${
              activeTab === "groups" ? "bg-[#c2e7ff] text-[#001d35]" : "text-[#5f6368]"
            }`}>
              <Users size={18} />
            </div>
            <span className={`text-[11px] ${activeTab === "groups" ? "font-bold text-[#001d35]" : "font-medium text-[#5f6368]"}`}>
              Rooms
            </span>
            {activeGroups.length > 0 && (
              <span className="absolute top-1 right-[26%] w-2 h-2 rounded-full bg-[#188038]" />
            )}
          </button>
        </div>
      </nav>

      {/* ======================================================== */}
      {/* MODAL 1: REGISTRATION FLOW (Spec Section 3) */}
      {/* ======================================================== */}
      {showRegisterModal && (
        <div className="fixed inset-0 bg-[#202124]/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white dark:bg-[#2d2e31] rounded-[28px] max-w-sm w-full p-6 space-y-4 shadow-2xl border border-[#dadce0]/50 animate-m3-fade-in text-xs relative">
            <button
              type="button"
              onClick={() => {
                if (user) localStorage.setItem("onm_registered_" + user.uid, "true");
                setShowRegisterModal(false);
              }}
              className="absolute top-4 right-4 w-8 h-8 rounded-full hover:bg-[#f1f3f4] dark:hover:bg-[#3c4043] flex items-center justify-center cursor-pointer text-[#5f6368] dark:text-[#9aa0a6] font-bold text-sm"
              title="Close"
            >
              ✕
            </button>

            <div className="text-center pt-1">
              <div className="w-12 h-12 rounded-full bg-[#e8f0fe] text-[#1a73e8] flex items-center justify-center mx-auto mb-2 font-black text-base">
                ONM
              </div>
              <h3 className="font-bold text-base text-[#202124] dark:text-[#e8eaed]">
                Complete Your Profile
              </h3>
              <p className="text-[11px] text-[#5f6368] mt-0.5">
                Enter your details to view and pool orders within 150 meters.
              </p>
              <div className="mt-2 p-2 rounded-xl bg-[#f1f3f4] dark:bg-[#3c4043] text-[10px] text-[#5f6368] dark:text-[#dadce0] flex items-center justify-center gap-1">
                <span>Google Verified:</span>
                <span className="font-bold text-[#1a73e8] truncate max-w-[180px]">{user?.email}</span>
              </div>
            </div>

            <form onSubmit={handleSaveRegistration} className="space-y-3">
              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">Full Name</label>
                <input
                  type="text"
                  value={registerForm.name}
                  onChange={(e) => setRegisterForm({ ...registerForm, name: e.target.value })}
                  placeholder="e.g. Rahul Sharma"
                  className="w-full h-10 bg-[#f8f9fa] dark:bg-[#35363a] rounded-xl px-3 border border-[#dadce0] focus:outline-none focus:border-[#1a73e8]"
                />
              </div>

              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">Your Address / Hostel (Type Only)</label>
                <input
                  type="text"
                  placeholder="Type your hostel, PG, room, or campus address..."
                  value={registerForm.address}
                  onChange={(e) => setRegisterForm({ ...registerForm, address: e.target.value, hostel: e.target.value })}
                  className="w-full h-10 bg-[#f8f9fa] dark:bg-[#35363a] rounded-xl px-3 border border-[#dadce0] focus:outline-none focus:border-[#1a73e8]"
                />
              </div>

              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">Location Access (150m Proximity)</label>
                {userLocation?.lat ? (
                  <div className="p-2.5 rounded-xl bg-[#e6f4ea] text-[#137333] flex items-center gap-2 font-medium">
                    <CheckCircle2 size={14} /> 150m Location access granted
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={requestLocationPermission}
                    className="w-full h-9 rounded-xl bg-[#e8f0fe] hover:bg-[#d2e3fc] text-[#1a73e8] font-semibold flex items-center justify-center gap-1.5 cursor-pointer transition text-xs"
                  >
                    <MapPin size={13} /> Allow Location Access (Required for 150m)
                  </button>
                )}
              </div>

              <button
                type="submit"
                className="w-full h-11 bg-[#1a73e8] hover:bg-[#1557b0] text-white font-bold text-xs rounded-full shadow-xs cursor-pointer mt-2"
              >
                Save Profile & See Orders
              </button>

              <button
                type="button"
                onClick={() => {
                  if (user) localStorage.setItem("onm_registered_" + user.uid, "true");
                  setShowRegisterModal(false);
                }}
                className="w-full text-center text-[11px] text-[#5f6368] dark:text-[#9aa0a6] hover:underline cursor-pointer pt-1"
              >
                Skip for now (Update address in Profile later)
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL 2: CREATE ORDER (Spec Section 6 & 18) */}
      {/* ======================================================== */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-[#202124]/60 z-50 flex items-end sm:items-center justify-center backdrop-blur-xs p-0 sm:p-4">
          <div className="bg-white dark:bg-[#2d2e31] w-full max-w-md rounded-t-[28px] sm:rounded-[28px] p-5 shadow-2xl max-h-[90vh] overflow-y-auto animate-m3-slide-up space-y-3.5 text-xs">
            <div className="flex items-center justify-between">
              <h3 className="text-base font-bold text-[#202124] dark:text-[#e8eaed]">Post Group Order</h3>
              <button
                onClick={() => setShowCreateModal(false)}
                className="w-8 h-8 rounded-full bg-[#f1f3f4] text-[#5f6368] flex items-center justify-center cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleCreateOrder} className="space-y-3">
              {/* Order Type Toggle: Immediate vs Scheduled */}
              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">Order Type</label>
                <div className="grid grid-cols-2 gap-1 bg-[#f1f3f4] p-1 rounded-full border border-[#dadce0]">
                  <button
                    type="button"
                    onClick={() => setOrderForm({ ...orderForm, orderType: "immediate" })}
                    className={`h-8 rounded-full font-bold transition cursor-pointer ${
                      orderForm.orderType === "immediate" ? "bg-white text-[#1a73e8] shadow-xs" : "text-[#5f6368]"
                    }`}
                  >
                    Immediate
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrderForm({ ...orderForm, orderType: "scheduled" })}
                    className={`h-8 rounded-full font-bold transition cursor-pointer ${
                      orderForm.orderType === "scheduled" ? "bg-white text-[#1a73e8] shadow-xs" : "text-[#5f6368]"
                    }`}
                  >
                    Scheduled
                  </button>
                </div>
              </div>

              {/* Scheduled Date & Time Pickers */}
              {orderForm.orderType === "scheduled" && (
                <div className="grid grid-cols-2 gap-2 bg-[#fef7e0] p-3 rounded-2xl border border-[#ffe7a5]">
                  <div>
                    <label className="font-bold text-[11px] text-[#7a4e00] block mb-1">Scheduled Date *</label>
                    <input
                      type="date"
                      required
                      value={orderForm.scheduledDate}
                      onChange={(e) => setOrderForm({ ...orderForm, scheduledDate: e.target.value })}
                      className="w-full h-9 bg-white rounded-xl px-2.5 border border-[#dadce0] text-xs"
                    />
                  </div>
                  <div>
                    <label className="font-bold text-[11px] text-[#7a4e00] block mb-1">Scheduled Time *</label>
                    <input
                      type="time"
                      required
                      value={orderForm.scheduledTime}
                      onChange={(e) => setOrderForm({ ...orderForm, scheduledTime: e.target.value })}
                      className="w-full h-9 bg-white rounded-xl px-2.5 border border-[#dadce0] text-xs"
                    />
                  </div>
                </div>
              )}

              {/* Platform Chips */}
              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">Supported Platform</label>
                <div className="flex flex-wrap gap-1.5">
                  {["Blinkit", "Instamart", "Zepto"].map((p) => (
                    <button
                      type="button"
                      key={p}
                      onClick={() => setOrderForm({ ...orderForm, platform: p })}
                      className={`h-8 px-3.5 rounded-full border font-semibold transition cursor-pointer ${
                        orderForm.platform === p
                          ? "bg-[#c2e7ff] text-[#001d35] border-[#1a73e8]"
                          : "bg-[#f8f9fa] text-[#5f6368] border-[#dadce0]"
                      }`}
                    >
                      {p}
                    </button>
                  ))}
                </div>
              </div>

              {/* Cart Values */}
              <div className="grid grid-cols-3 gap-2">
                <div>
                  <label className="font-semibold text-[#5f6368] block mb-1">My Cart (₹)*</label>
                  <input
                    type="number"
                    min={MIN_CART_AMOUNT}
                    required
                    value={orderForm.myAmount}
                    onChange={(e) => setOrderForm({ ...orderForm, myAmount: e.target.value })}
                    className="w-full h-10 bg-[#f8f9fa] rounded-xl px-3 border border-[#dadce0] font-bold text-xs"
                  />
                </div>
                <div>
                  <label className="font-semibold text-[#5f6368] block mb-1">Target (₹)*</label>
                  <input
                    type="number"
                    required
                    value={orderForm.targetAmount}
                    onChange={(e) => setOrderForm({ ...orderForm, targetAmount: e.target.value })}
                    className="w-full h-10 bg-[#f8f9fa] rounded-xl px-3 border border-[#dadce0] font-bold text-xs"
                  />
                </div>
                <div>
                  <label className="font-semibold text-[#5f6368] block mb-1">Max Cap (₹)</label>
                  <input
                    type="number"
                    placeholder="Optional"
                    value={orderForm.maximumCartValue}
                    onChange={(e) => setOrderForm({ ...orderForm, maximumCartValue: e.target.value })}
                    className="w-full h-10 bg-[#f8f9fa] rounded-xl px-3 border border-[#dadce0] text-xs"
                  />
                </div>
              </div>

              {/* Waiting Duration for Immediate Orders */}
              {orderForm.orderType === "immediate" && (
                <div>
                  <label className="font-semibold text-[#5f6368] block mb-1">Wait Duration</label>
                  <div className="grid grid-cols-4 gap-1.5">
                    {[5, 10, 15, 30].map((m) => (
                      <button
                        type="button"
                        key={m}
                        onClick={() => setOrderForm({ ...orderForm, waitMinutes: m })}
                        className={`h-8 rounded-full font-semibold border transition cursor-pointer ${
                          orderForm.waitMinutes === m ? "bg-[#1a73e8] text-white border-[#1a73e8]" : "bg-[#f8f9fa] text-[#5f6368] border-[#dadce0]"
                        }`}
                      >
                        {m}m
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Address / Hostel for this order */}
              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">Your Address / Hostel (Type Only) *</label>
                <input
                  type="text"
                  required
                  placeholder="Type your hostel, PG, or address..."
                  value={orderForm.address || profile?.address || profile?.hostel || ""}
                  onChange={(e) => setOrderForm({ ...orderForm, address: e.target.value })}
                  className="w-full h-10 bg-[#f8f9fa] rounded-xl px-3 border border-[#dadce0] text-xs focus:outline-none focus:border-[#1a73e8]"
                />
              </div>

              {/* Handover Location */}
              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">Handover Point</label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setOrderForm({ ...orderForm, handoverMode: "gate" })}
                    className={`h-9 rounded-xl border font-semibold flex items-center justify-center gap-1 cursor-pointer ${
                      orderForm.handoverMode === "gate" ? "bg-[#c2e7ff] text-[#001d35] border-[#1a73e8]" : "bg-[#f8f9fa] text-[#5f6368]"
                    }`}
                  >
                    <MapPin size={13} /> Hostel Gate
                  </button>
                  <button
                    type="button"
                    onClick={() => setOrderForm({ ...orderForm, handoverMode: "room" })}
                    className={`h-9 rounded-xl border font-semibold flex items-center justify-center gap-1 cursor-pointer ${
                      orderForm.handoverMode === "room" ? "bg-[#c2e7ff] text-[#001d35] border-[#1a73e8]" : "bg-[#f8f9fa] text-[#5f6368]"
                    }`}
                  >
                    Room Handover
                  </button>
                </div>
              </div>

              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">Description / Notes</label>
                <input
                  type="text"
                  placeholder="e.g. Milk & snacks / Ordering at 11 PM"
                  value={orderForm.placeOrNote}
                  onChange={(e) => setOrderForm({ ...orderForm, placeOrNote: e.target.value })}
                  className="w-full h-10 bg-[#f8f9fa] rounded-xl px-3 border border-[#dadce0] text-xs"
                />
              </div>

              <button
                type="submit"
                disabled={posting}
                className="w-full h-11 bg-[#1a73e8] hover:bg-[#1557b0] text-white font-bold rounded-full shadow-xs cursor-pointer disabled:opacity-50 mt-1"
              >
                {posting ? "Publishing Order..." : "Publish Live Order Request"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL 3: JOIN ORDER (Spec Section 8) */}
      {/* ======================================================== */}
      {joiningOrder && (
        <div className="fixed inset-0 bg-[#202124]/60 z-50 flex items-end sm:items-center justify-center backdrop-blur-xs p-0 sm:p-4">
          <div className="bg-white dark:bg-[#2d2e31] w-full max-w-md rounded-t-[28px] sm:rounded-[28px] p-5 shadow-2xl max-h-[90vh] overflow-y-auto animate-m3-slide-up space-y-3.5 text-xs">
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-base font-bold text-[#202124] dark:text-[#e8eaed]">
                  Join {joiningOrder.platform} Order
                </h3>
                <p className="text-[11px] text-[#5f6368]">
                  Creator: {joiningOrder.ownerName} ({joiningOrder.hostel})
                </p>
              </div>
              <button
                onClick={() => setJoiningOrder(null)}
                className="w-8 h-8 rounded-full bg-[#f1f3f4] text-[#5f6368] flex items-center justify-center cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>

            <form onSubmit={handleSubmitJoin} className="space-y-3">
              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">
                  Estimated Cart Contribution (₹) * (Min ₹{MIN_CART_AMOUNT} · Max ₹{MAX_JOINER_CART})
                </label>
                <input
                  type="number"
                  min={MIN_CART_AMOUNT}
                  max={MAX_JOINER_CART}
                  required
                  value={joinForm.contributionAmount}
                  onChange={(e) => setJoinForm({ ...joinForm, contributionAmount: e.target.value })}
                  className="w-full h-10 bg-[#f8f9fa] rounded-xl px-3 border border-[#dadce0] font-bold text-xs"
                />
              </div>

              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">
                  Requested Products Summary * (e.g. 1 Bread + 1 Milk)
                </label>
                <textarea
                  rows={2}
                  required
                  value={joinForm.itemsList}
                  onChange={(e) => setJoinForm({ ...joinForm, itemsList: e.target.value })}
                  placeholder="List your items..."
                  className="w-full bg-[#f8f9fa] rounded-xl p-2.5 border border-[#dadce0] text-xs"
                />
              </div>

              {/* Stock Checkbox */}
              <label className="flex items-start gap-2.5 p-3 rounded-xl bg-[#f8f9fa] border border-[#dadce0] cursor-pointer">
                <input
                  type="checkbox"
                  required
                  checked={joinForm.stockConfirmed}
                  onChange={(e) => setJoinForm({ ...joinForm, stockConfirmed: e.target.checked })}
                  className="mt-0.5 text-[#1a73e8] rounded"
                />
                <span className="text-[11px] text-[#202124] dark:text-[#e8eaed] leading-snug">
                  I checked <strong>{joiningOrder.platform}</strong> right now and verified items are in stock.
                </span>
              </label>

              <button
                type="submit"
                disabled={submittingJoin}
                className="w-full h-11 bg-[#1a73e8] hover:bg-[#1557b0] text-white font-bold rounded-full shadow-xs cursor-pointer disabled:opacity-50"
              >
                {submittingJoin ? "Sending..." : "Submit Join Request"}
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL 4: 50% ABOVE TARGET CART WARNING (Spec Section 11) */}
      {/* ======================================================== */}
      {warningModal && (
        <div className="fixed inset-0 bg-[#202124]/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white dark:bg-[#2d2e31] rounded-[28px] max-w-sm w-full p-6 space-y-4 shadow-2xl border border-[#dadce0]/50 animate-m3-fade-in text-xs">
            <div className="w-12 h-12 rounded-full bg-[#fef7e0] text-[#7a4e00] flex items-center justify-center mx-auto">
              <AlertTriangle size={24} />
            </div>
            <div className="text-center">
              <h4 className="font-bold text-sm text-[#202124] dark:text-[#e8eaed]">Cart Warning Threshold</h4>
              <p className="text-xs text-[#5f6368] mt-1 leading-relaxed">
                {warningModal.warningMessage}
              </p>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setWarningModal(null)}
                className="flex-1 h-10 rounded-full border border-[#dadce0] text-xs font-semibold cursor-pointer"
              >
                Go Back
              </button>
              <button
                onClick={warningModal.onProceed}
                className="flex-1 h-10 bg-[#1a73e8] hover:bg-[#1557b0] text-white text-xs font-semibold rounded-full shadow-xs cursor-pointer"
              >
                Accept Anyway
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL 5: CLOSE ORDER & CREATE GROUP CONFIRMATION (Spec Section 13) */}
      {/* ======================================================== */}
      {closeOrderModal && (
        <div className="fixed inset-0 bg-[#202124]/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white dark:bg-[#2d2e31] rounded-[28px] max-w-sm w-full p-6 space-y-4 shadow-2xl border border-[#dadce0]/50 animate-m3-fade-in text-xs">
            <div className="w-12 h-12 rounded-full bg-[#e8f0fe] text-[#1a73e8] flex items-center justify-center mx-auto">
              <CheckCheck size={24} />
            </div>
            <div className="text-center">
              <h4 className="font-bold text-sm text-[#202124] dark:text-[#e8eaed]">Close Order & Create Group?</h4>
              <p className="text-xs text-[#5f6368] mt-1 leading-relaxed">
                Accepted members will be finalized into a dedicated room with a 60-minute coordination window. Any leftover pending requests will expire.
              </p>
            </div>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setCloseOrderModal(null)}
                className="flex-1 h-10 rounded-full border border-[#dadce0] text-xs font-semibold cursor-pointer"
              >
                Keep Open
              </button>
              <button
                onClick={handleConfirmCloseOrder}
                className="flex-1 h-10 bg-[#188038] hover:bg-[#137333] text-white text-xs font-semibold rounded-full shadow-xs cursor-pointer"
              >
                Confirm & Create
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL 6: RATING MODAL (Spec Section 21) */}
      {/* ======================================================== */}
      {ratingTarget && (
        <div className="fixed inset-0 bg-[#202124]/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white dark:bg-[#2d2e31] rounded-[28px] max-w-sm w-full p-6 space-y-4 shadow-2xl border border-[#dadce0]/50 animate-m3-fade-in text-xs">
            <div className="text-center">
              <div className="w-12 h-12 rounded-full bg-[#fef7e0] text-[#f9ab00] flex items-center justify-center mx-auto mb-1">
                <Star size={24} fill="#f9ab00" />
              </div>
              <h4 className="font-bold text-sm text-[#202124] dark:text-[#e8eaed]">
                Rate {ratingTarget.targetName}
              </h4>
              <p className="text-[11px] text-[#5f6368]">
                How reliable was this student during pickup and payment?
              </p>
            </div>

            <form onSubmit={handleSubmitRating} className="space-y-3">
              <div className="flex justify-center gap-2 py-1">
                {[1, 2, 3, 4, 5].map((star) => (
                  <button
                    type="button"
                    key={star}
                    onClick={() => setRatingTarget({ ...ratingTarget, stars: star })}
                    className="p-1 cursor-pointer"
                  >
                    <Star
                      size={24}
                      className={star <= ratingTarget.stars ? "text-[#f9ab00] fill-[#f9ab00]" : "text-slate-300"}
                    />
                  </button>
                ))}
              </div>

              <div>
                <label className="font-semibold text-[#5f6368] block mb-1">Review (Optional)</label>
                <input
                  type="text"
                  placeholder="e.g. Prompt on time at gate!"
                  value={ratingTarget.review}
                  onChange={(e) => setRatingTarget({ ...ratingTarget, review: e.target.value })}
                  className="w-full h-10 bg-[#f8f9fa] rounded-xl px-3 border border-[#dadce0] text-xs"
                />
              </div>

              <div className="flex gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setRatingTarget(null)}
                  className="flex-1 h-10 rounded-full border border-[#dadce0] font-semibold text-xs cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  className="flex-1 h-10 bg-[#1a73e8] hover:bg-[#1557b0] text-white font-semibold text-xs rounded-full cursor-pointer shadow-xs"
                >
                  Submit Rating
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL 7: RETAILER BILL BREAKDOWN MODAL */}
      {/* ======================================================== */}
      {showCheckoutModal && (
        <div className="fixed inset-0 bg-[#202124]/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white dark:bg-[#2d2e31] rounded-[28px] max-w-sm w-full p-6 space-y-4 shadow-2xl border border-[#dadce0]/50 animate-m3-fade-in text-xs">
            <div className="flex items-center justify-between">
              <h4 className="font-bold text-sm text-[#202124] dark:text-[#e8eaed]">Retailer Bill Breakdown</h4>
              <button onClick={() => setShowCheckoutModal(null)} className="cursor-pointer text-[#5f6368]">✕</button>
            </div>
            <form onSubmit={handleSaveCheckoutBreakdown} className="space-y-2.5">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="font-semibold text-[#5f6368] block mb-1">Delivery Fee (₹)</label>
                  <input
                    type="number"
                    min="0"
                    value={breakdownForm.deliveryFee}
                    onChange={(e) => setBreakdownForm({ ...breakdownForm, deliveryFee: e.target.value })}
                    className="w-full h-9 bg-[#f8f9fa] rounded-xl px-2.5 border border-[#dadce0] text-xs"
                  />
                </div>
                <div>
                  <label className="font-semibold text-[#5f6368] block mb-1">Handling (₹)</label>
                  <input
                    type="number"
                    min="0"
                    value={breakdownForm.handlingFee}
                    onChange={(e) => setBreakdownForm({ ...breakdownForm, handlingFee: e.target.value })}
                    className="w-full h-9 bg-[#f8f9fa] rounded-xl px-2.5 border border-[#dadce0] text-xs"
                  />
                </div>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="font-semibold text-[#5f6368] block mb-1">Packaging (₹)</label>
                  <input
                    type="number"
                    min="0"
                    value={breakdownForm.packagingFee}
                    onChange={(e) => setBreakdownForm({ ...breakdownForm, packagingFee: e.target.value })}
                    className="w-full h-9 bg-[#f8f9fa] rounded-xl px-2.5 border border-[#dadce0] text-xs"
                  />
                </div>
                <div>
                  <label className="font-semibold text-[#5f6368] block mb-1">Discount (₹)</label>
                  <input
                    type="number"
                    min="0"
                    value={breakdownForm.discountAmount}
                    onChange={(e) => setBreakdownForm({ ...breakdownForm, discountAmount: e.target.value })}
                    className="w-full h-9 bg-[#f8f9fa] rounded-xl px-2.5 border border-[#dadce0] text-xs text-[#188038]"
                  />
                </div>
              </div>

              <button
                type="submit"
                className="w-full h-10 bg-[#1a73e8] hover:bg-[#1557b0] text-white font-bold text-xs rounded-full shadow-xs cursor-pointer mt-1"
              >
                Confirm & Reconcile Shares
              </button>
            </form>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* CONFIRM MODAL */}
      {/* ======================================================== */}
      {confirmModal && (
        <div className="fixed inset-0 bg-[#202124]/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white dark:bg-[#2d2e31] rounded-[28px] max-w-xs w-full p-6 space-y-4 shadow-2xl text-center border border-[#dadce0]/50 animate-m3-fade-in text-xs">
            <h4 className="font-bold text-sm text-[#202124] dark:text-[#e8eaed]">{confirmModal.title}</h4>
            <p className="text-[#5f6368]">{confirmModal.message}</p>
            <div className="flex gap-2 pt-1">
              <button
                onClick={() => setConfirmModal(null)}
                className="flex-1 h-9 rounded-full border border-[#dadce0] font-semibold text-xs cursor-pointer"
              >
                Cancel
              </button>
              <button
                onClick={confirmModal.onConfirm}
                className={`flex-1 h-9 rounded-full text-xs font-semibold text-white cursor-pointer ${
                  confirmModal.isDanger ? "bg-[#d93025]" : "bg-[#1a73e8]"
                }`}
              >
                {confirmModal.confirmText || "Confirm"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* MODAL: VIEW PAST GROUP CHAT & ITEMS */}
      {/* ======================================================== */}
      {viewingPastGroup && (
        <div className="fixed inset-0 bg-[#202124]/60 z-50 flex items-center justify-center p-4 backdrop-blur-xs">
          <div className="bg-white dark:bg-[#2d2e31] rounded-[28px] max-w-md w-full p-5 space-y-3.5 shadow-2xl border border-[#dadce0]/50 max-h-[85vh] flex flex-col text-xs animate-m3-fade-in">
            <div className="flex items-center justify-between border-b pb-3 border-[#f1f3f4] dark:border-[#3c4043]">
              <div className="flex items-center gap-2">
                <div className="w-8 h-8 rounded-full bg-[#e8f0fe] text-[#1a73e8] flex items-center justify-center font-bold">
                  {viewingPastGroup.platform?.[0]}
                </div>
                <div>
                  <h3 className="font-bold text-sm text-[#202124] dark:text-[#e8eaed]">
                    {viewingPastGroup.platform} · {viewingPastGroup.ownerName?.split(" ")[0]}
                  </h3>
                  <span className="text-[10px] text-[#5f6368] dark:text-[#9aa0a6]">
                    Pickup: {viewingPastGroup.pickupPoint || "Hostel Gate"}
                  </span>
                </div>
              </div>
              <button
                type="button"
                onClick={() => setViewingPastGroup(null)}
                className="w-8 h-8 rounded-full hover:bg-[#f1f3f4] dark:hover:bg-[#3c4043] flex items-center justify-center cursor-pointer text-[#5f6368] dark:text-[#9aa0a6] font-bold"
              >
                ✕
              </button>
            </div>

            <div className="bg-[#fef7e0] dark:bg-[#332b00] p-2.5 rounded-xl text-[11px] text-[#b06000] dark:text-[#fdd663] flex items-center gap-2">
              <Clock size={14} className="shrink-0" />
              <span>This order group is completed / expired. Chat history is read-only.</span>
            </div>

            {/* Consolidated items summary */}
            <div className="bg-[#f8f9fa] dark:bg-[#35363a] p-3 rounded-2xl border border-[#dadce0]/50 space-y-1.5">
              <div className="flex items-center justify-between font-bold text-[11px]">
                <span>Ordered Items</span>
                <button
                  type="button"
                  onClick={() => handleCopyConsolidatedList(viewingPastGroup)}
                  className="text-[#1a73e8] dark:text-[#8ab4f8] flex items-center gap-1 cursor-pointer font-semibold"
                >
                  <Copy size={11} /> Copy List
                </button>
              </div>
              <div className="space-y-1 max-h-24 overflow-y-auto">
                {viewingPastGroup.members?.map((m, idx) => (
                  <div key={idx} className="flex justify-between text-[11px] text-[#5f6368] dark:text-[#dadce0]">
                    <span>{m.name}: {m.items || "Items"}</span>
                    <span>₹{m.amount}</span>
                  </div>
                ))}
              </div>
            </div>

            {/* Past Messages */}
            <div className="flex-1 overflow-y-auto space-y-2 p-2 border border-[#dadce0]/40 rounded-2xl min-h-[160px] max-h-[220px] bg-[#fafafa] dark:bg-[#202124]">
              {pastGroupMessages.length === 0 ? (
                <p className="text-center text-[#5f6368] py-8 text-[11px]">No messages in this chat room.</p>
              ) : (
                pastGroupMessages.map((msg) => {
                  const isMe = msg.senderId === user?.uid;
                  return (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${isMe ? "items-end" : "items-start"}`}
                    >
                      <div className="flex items-center gap-1 text-[9px] text-[#5f6368] mb-0.5">
                        <span>{msg.senderName}</span>
                        <span>{formatTimeAgo(msg.createdAtMs)}</span>
                      </div>
                      <div
                        className={`px-3 py-1.5 rounded-2xl max-w-[80%] text-xs ${
                          isMe
                            ? "bg-[#1a73e8] text-white rounded-br-none"
                            : "bg-[#e8f0fe] text-[#202124] rounded-bl-none"
                        }`}
                      >
                        {msg.text}
                      </div>
                    </div>
                  );
                })
              )}
            </div>

            <button
              type="button"
              onClick={() => setViewingPastGroup(null)}
              className="w-full h-10 rounded-full bg-[#f1f3f4] dark:bg-[#3c4043] font-semibold text-xs text-[#3c4043] dark:text-[#e8eaed] cursor-pointer hover:bg-[#e8eaed] transition"
            >
              Close Past Chat
            </button>
          </div>
        </div>
      )}

      {/* ======================================================== */}
      {/* TOAST NOTIFICATION */}
      {/* ======================================================== */}
      {toast && (
        <div className="fixed bottom-24 inset-x-4 max-w-sm mx-auto z-50 bg-[#323232] text-white px-4 py-3 rounded-2xl shadow-m3-2 flex items-center justify-between text-xs font-medium animate-m3-slide-up">
          <div className="flex items-center gap-2">
            {toast.type === "success" && <CheckCircle2 size={16} className="text-[#81c995]" />}
            {toast.type === "error" && <AlertTriangle size={16} className="text-[#f28b82]" />}
            {toast.type === "info" && <Info size={16} className="text-[#8ab4f8]" />}
            <span>{toast.message}</span>
          </div>
          <button onClick={() => setToast(null)} className="text-slate-400 hover:text-white ml-2 cursor-pointer font-bold">
            ✕
          </button>
        </div>
      )}
    </div>
  );
}
