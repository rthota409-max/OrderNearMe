/**
 * Authoritative Notification Service
 * Manages persistent in-app notifications in Firestore `notifications/{notificationId}`
 */

import {
  collection,
  addDoc,
  doc,
  updateDoc,
  serverTimestamp
} from "firebase/firestore";
import { NOTIFICATION_TYPES } from "../constants/orderLifecycle.js";

/**
 * Creates a persistent notification for a specific recipient user.
 */
export async function sendNotification(db, {
  recipientId,
  type,
  title,
  body,
  orderId = null,
  groupId = null
}) {
  if (!recipientId || !type) return null;

  try {
    const notifData = {
      recipientId,
      type,
      title: title || "OrderNearMe Update",
      body: body || "",
      orderId: orderId || null,
      groupId: groupId || null,
      isRead: false,
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    };

    const ref = await addDoc(collection(db, "notifications"), notifData);
    return { id: ref.id, ...notifData };
  } catch (err) {
    console.error("Failed to send notification:", err);
    return null;
  }
}

/**
 * Marks a notification as read.
 */
export async function markNotificationAsRead(db, notificationId) {
  if (!notificationId) return;
  try {
    await updateDoc(doc(db, "notifications", notificationId), {
      isRead: true,
      readAtMs: Date.now()
    });
  } catch (err) {
    console.error("Error marking notification read:", err);
  }
}
