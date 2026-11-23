/**
 * Authoritative Join Request & Group Membership Service
 * 
 * Conforms to OrderNearMe Master Project Specification:
 * - Up to 3 active pending requests per user.
 * - Atomic host acceptance with concurrent collision protection.
 * - Enforces maximumCartValue ceiling.
 * - Automatic withdrawal of other pending requests once matched.
 * - Persistent notification dispatch for acceptance, rejection, and auto-withdrawal.
 * - Voluntary leave & reasoned member removal with exact cart recalculation.
 */

import {
  collection,
  doc,
  addDoc,
  getDoc,
  updateDoc,
  arrayUnion,
  runTransaction
} from "firebase/firestore";
import {
  ORDER_STATUS,
  REQUEST_STATUS,
  NOTIFICATION_TYPES,
  getOrderJoinableStatus
} from "../constants/orderLifecycle.js";
import {
  validateJoinRequest,
  MAX_PENDING_REQUESTS_PER_USER
} from "./validation.js";
import { sendNotification } from "./notificationService.js";

/**
 * Creates a join request with pre-validation and 3-order pending limit enforcement.
 */
export async function createJoinRequest(db, user, profile, order, form, allUserJoinRequests = []) {
  if (!user || !user.uid) {
    throw new Error("Sign in required to join orders.");
  }

  if (order.creatorId === user.uid || order.ownerId === user.uid) {
    throw new Error("You cannot send a join request to your own order.");
  }

  // Authoritative check if order is currently open
  const joinCheck = getOrderJoinableStatus(order);
  if (!joinCheck.joinable) {
    throw new Error(`Order cannot be joined: ${joinCheck.reason}`);
  }

  // Validate form payload
  const valResult = validateJoinRequest(form, order);
  if (!valResult.valid) {
    throw new Error(valResult.error);
  }

  // Check if user is already an accepted member of an active group
  if (profile?.activeGroupId) {
    let isCurrentlyActive = false;
    try {
      if (db && typeof db.getDoc === "function") {
        const snap = db.getDoc(`groups/${profile.activeGroupId}`);
        if (snap && (typeof snap.exists !== "function" || snap.exists())) {
          const gData = typeof snap.data === "function" ? snap.data() : snap;
          const isExp = (gData?.expiresAtMs && Date.now() >= gData.expiresAtMs) ||
            gData?.status === "completed" || gData?.status === "archived";
          if (!isExp) isCurrentlyActive = true;
        }
      } else {
        const gSnap = await getDoc(doc(db, "groups", profile.activeGroupId));
        if (gSnap.exists()) {
          const gData = gSnap.data();
          const isExp = (gData?.expiresAtMs && Date.now() >= gData.expiresAtMs) ||
            gData?.status === "completed" || gData?.status === "archived";
          if (!isExp) isCurrentlyActive = true;
        }
      }
    } catch {
      // If error querying group doc, treat as inactive so user is not permanently trapped
      isCurrentlyActive = false;
    }

    if (isCurrentlyActive) {
      throw new Error("You are already an accepted member of an active purchasing group for this cycle.");
    } else {
      // Stale or expired activeGroupId: clear it
      try {
        if (db && typeof db.updateDoc === "function") {
          db.updateDoc(`users/${user.uid}`, { activeGroupId: null, activeOrderId: null });
        } else {
          await updateDoc(doc(db, "users", user.uid), { activeGroupId: null, activeOrderId: null });
        }
      } catch {}
      if (profile) profile.activeGroupId = null;
    }
  }

  // Enforce: at most 3 distinct active pending requests per user
  const activePending = allUserJoinRequests.filter(
    (r) => r.requesterId === user.uid && r.status === REQUEST_STATUS.PENDING
  );

  const alreadyRequestedThisOrder = activePending.some((r) => r.orderId === order.id);
  if (alreadyRequestedThisOrder) {
    throw new Error("You already have an active pending request for this order.");
  }

  const distinctHostOrders = new Set(activePending.map((r) => r.orderId));
  if (distinctHostOrders.size >= MAX_PENDING_REQUESTS_PER_USER) {
    throw new Error(
      `You can have pending requests to at most ${MAX_PENDING_REQUESTS_PER_USER} active orders at a time.`
    );
  }

  const amount = Math.round(Number(form.contributionAmount));
  const now = Date.now();

  const reqData = {
    orderId: order.id,
    orderPlatform: order.platform,
    creatorId: order.creatorId || order.ownerId,
    ownerId: order.ownerId || order.creatorId,
    requesterId: user.uid,
    requesterName: profile?.name || user.displayName || "Hostel Mate",
    requesterPhoto: profile?.photo || user.photoURL || "",
    requesterHostel: profile?.hostel || profile?.address || "Campus Block",
    requesterRating:
      profile?.ratingCount > 0
        ? (profile.ratingSum / profile.ratingCount).toFixed(1)
        : "5.0",
    contributionAmount: amount,
    estimatedCartValue: amount,
    itemsList: form.itemsList.trim(),
    requestedItems: form.itemsList.trim(),
    note: (form.note || "").trim(),
    stockConfirmed: true,
    status: REQUEST_STATUS.PENDING,
    requestedAt: now,
    createdAtMs: now
  };

  const docRef = await addDoc(collection(db, "joinRequests"), reqData);

  // Increment order's pendingRequestCount and potential cart
  try {
    const orderRef = doc(db, "orders", order.id);
    await updateDoc(orderRef, {
      pendingRequestCount: (order.pendingRequestCount || 0) + 1,
      pendingPotentialCartValue: (order.pendingPotentialCartValue || 0) + amount
    });
  } catch (e) {
    console.error("Error updating order pending stats:", e);
  }

  // Send notification to creator
  await sendNotification(db, {
    recipientId: order.creatorId || order.ownerId,
    type: NOTIFICATION_TYPES.JOIN_REQUEST_RECEIVED,
    title: "New Join Request",
    body: `${reqData.requesterName} requested to pool ₹${amount} for ${order.platform}.`,
    orderId: order.id
  });

  return { id: docRef.id, ...reqData };
}

/**
 * Requester voluntarily withdraws their own PENDING request.
 */
export async function withdrawJoinRequestAtomic(db, requestId, requesterUserId) {
  const reqRef = doc(db, "joinRequests", requestId);

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(reqRef);
    if (!snap.exists()) throw new Error("Join request does not exist.");
    const req = snap.data();

    if (req.requesterId !== requesterUserId) {
      throw new Error("You can only withdraw your own requests.");
    }
    if (req.status !== REQUEST_STATUS.PENDING) {
      throw new Error(`Cannot withdraw request with status '${req.status}'.`);
    }

    const orderRef = doc(db, "orders", req.orderId);
    const orderSnap = await txn.get(orderRef);

    txn.update(reqRef, {
      status: REQUEST_STATUS.WITHDRAWN,
      respondedAtMs: Date.now()
    });

    if (orderSnap.exists()) {
      const order = orderSnap.data();
      const newPendingCount = Math.max(0, (order.pendingRequestCount || 1) - 1);
      const newPendingPotential = Math.max(0, (order.pendingPotentialCartValue || req.contributionAmount) - req.contributionAmount);
      txn.update(orderRef, {
        pendingRequestCount: newPendingCount,
        pendingPotentialCartValue: newPendingPotential
      });
    }

    return { requestId, status: REQUEST_STATUS.WITHDRAWN };
  });
}

/**
 * Atomically accepts or declines a join request.
 * Concurrency Safety:
 * - Checks if requester has already been accepted into another group for this purchasing cycle.
 * - Automatically withdraws all competing pending requests on acceptance.
 */
export async function respondJoinRequestAtomic(db, requestId, creatorUserId, decision, allJoinRequests = []) {
  const reqRef = doc(db, "joinRequests", requestId);

  const result = await runTransaction(db, async (txn) => {
    const reqSnap = await txn.get(reqRef);
    if (!reqSnap.exists()) {
      throw new Error("Join request no longer exists.");
    }
    const req = reqSnap.data();

    if (req.ownerId !== creatorUserId && req.creatorId !== creatorUserId) {
      throw new Error("Only the order creator can accept or decline this request.");
    }

    if (req.status !== REQUEST_STATUS.PENDING) {
      throw new Error(`This request is already ${req.status}.`);
    }

    const orderRef = doc(db, "orders", req.orderId);
    const orderSnap = await txn.get(orderRef);

    if (decision === "rejected") {
      txn.update(reqRef, {
        status: REQUEST_STATUS.REJECTED,
        respondedAt: Date.now(),
        respondedAtMs: Date.now()
      });

      if (orderSnap.exists()) {
        const order = orderSnap.data();
        txn.update(orderRef, {
          pendingRequestCount: Math.max(0, (order.pendingRequestCount || 1) - 1),
          pendingPotentialCartValue: Math.max(0, (order.pendingPotentialCartValue || req.contributionAmount) - req.contributionAmount)
        });
      }

      return { decision: "rejected", req };
    }

    // --- Acceptance Flow ---
    // Concurrency Check 1: Verify requester is not already in an active group
    const requesterUserRef = doc(db, "users", req.requesterId);
    const requesterUserSnap = await txn.get(requesterUserRef);
    let clearRequesterStaleGroup = false;
    if (requesterUserSnap.exists()) {
      const uData = requesterUserSnap.data();
      if (uData.activeGroupId) {
        const activeGroupRef = doc(db, "groups", uData.activeGroupId);
        const activeGroupSnap = await txn.get(activeGroupRef);
        let isGroupActive = false;
        if (activeGroupSnap.exists()) {
          const gd = activeGroupSnap.data();
          const isExp = (gd?.expiresAtMs && Date.now() >= gd.expiresAtMs) ||
            gd?.status === "completed" || gd?.status === "archived";
          if (!isExp) isGroupActive = true;
        }

        if (isGroupActive) {
          throw new Error("This requester has already been accepted into another order group.");
        } else {
          clearRequesterStaleGroup = true;
        }
      }
    }

    // Verify parent order is still open & eligible
    if (!orderSnap.exists()) {
      throw new Error("Parent order no longer exists.");
    }
    const order = orderSnap.data();

    const joinStatus = getOrderJoinableStatus(order);
    if (!joinStatus.joinable) {
      throw new Error(`Cannot accept request: ${joinStatus.reason}.`);
    }

    const currentAcceptedCart = Number(order.acceptedCartValue ?? order.currentCart ?? order.myAmount ?? 0);
    const reqAmount = Number(req.contributionAmount || req.estimatedCartValue || 0);
    const newAcceptedCart = currentAcceptedCart + reqAmount;

    // Hard ceiling check on maximumCartValue (Spec Section 11)
    if (order.maximumCartValue && newAcceptedCart > Number(order.maximumCartValue)) {
      throw new Error(`Accepting this request would exceed order's maximum cart cap of ₹${order.maximumCartValue}.`);
    }

    const currentParticipants = Number(order.participantCount || order.memberCount || 1);
    const newParticipants = currentParticipants + 1;
    const newPendingCount = Math.max(0, (order.pendingRequestCount || 1) - 1);
    const newPendingPotential = Math.max(0, (order.pendingPotentialCartValue || reqAmount) - reqAmount);

    // Check if target reached -> trigger READY_TO_CLOSE status
    const targetAmount = Number(order.targetCartValue || order.targetAmount || 199);
    const isTargetReached = newAcceptedCart >= targetAmount;
    const nextOrderStatus = isTargetReached ? ORDER_STATUS.READY_TO_CLOSE : ORDER_STATUS.MATCHED;

    // Atomically mark request as accepted
    txn.update(reqRef, {
      status: REQUEST_STATUS.ACCEPTED,
      respondedAt: Date.now(),
      respondedAtMs: Date.now()
    });

    if (clearRequesterStaleGroup) {
      txn.update(requesterUserRef, { activeGroupId: null, activeOrderId: null });
    }

    // Atomically update order
    txn.update(orderRef, {
      acceptedCartValue: newAcceptedCart,
      currentCart: newAcceptedCart,
      participantCount: newParticipants,
      memberCount: newParticipants,
      pendingRequestCount: newPendingCount,
      pendingPotentialCartValue: newPendingPotential,
      acceptedRequesterIds: arrayUnion(req.requesterId),
      status: nextOrderStatus
    });

    return {
      decision: "accepted",
      req,
      isTargetReached,
      order: {
        id: req.orderId,
        ...order,
        acceptedCartValue: newAcceptedCart,
        participantCount: newParticipants,
        status: nextOrderStatus
      }
    };
  });

  // Notifications and Auto-Withdrawal
  if (result.decision === "accepted") {
    // 1. Notify accepted requester
    await sendNotification(db, {
      recipientId: result.req.requesterId,
      type: NOTIFICATION_TYPES.JOIN_REQUEST_ACCEPTED,
      title: "Request Accepted! 🎉",
      body: `Your request to join ${result.req.orderPlatform} order was accepted.`,
      orderId: result.req.orderId
    });

    // 2. Notify creator if target reached
    if (result.isTargetReached) {
      await sendNotification(db, {
        recipientId: creatorUserId,
        type: NOTIFICATION_TYPES.CART_TARGET_REACHED,
        title: "Target Cart Value Reached!",
        body: `Your target of ₹${result.order.targetAmount || 199} has been reached. You can now close your request and create your group.`,
        orderId: result.req.orderId
      });
    }

    // 3. Spec Section 10: Automatic withdrawal of other pending requests sent by this requester
    const otherPending = allJoinRequests.filter(
      (r) => r.requesterId === result.req.requesterId && r.id !== requestId && r.status === REQUEST_STATUS.PENDING
    );

    for (const other of otherPending) {
      try {
        await updateDoc(doc(db, "joinRequests", other.id), {
          status: REQUEST_STATUS.AUTO_WITHDRAWN,
          respondedAt: Date.now(),
          respondedAtMs: Date.now(),
          withdrawalReason: "Matched with another order"
        });

        // Notify other creator
        await sendNotification(db, {
          recipientId: other.creatorId || other.ownerId,
          type: NOTIFICATION_TYPES.JOIN_REQUEST_WITHDRAWN,
          title: "Requester No Longer Available",
          body: `${result.req.requesterName} was accepted into another order and was auto-withdrawn.`,
          orderId: other.orderId
        });

        // Notify requester about auto-withdrawal
        await sendNotification(db, {
          recipientId: result.req.requesterId,
          type: NOTIFICATION_TYPES.AUTO_WITHDRAWAL,
          title: "Pending Request Auto-Withdrawn",
          body: `Your pending request on ${other.orderPlatform} was auto-withdrawn because you joined another order.`,
          orderId: other.orderId
        });
      } catch (err) {
        console.error("Error auto-withdrawing competing request:", err);
      }
    }
  } else {
    // Rejection notification
    await sendNotification(db, {
      recipientId: result.req.requesterId,
      type: NOTIFICATION_TYPES.JOIN_REQUEST_REJECTED,
      title: "Request Declined",
      body: `Your request to join the ${result.req.orderPlatform} order was not accepted.`,
      orderId: result.req.orderId
    });
  }

  return result;
}

/**
 * Member leaves an active group before finalization (Spec Section 16).
 */
export async function leaveGroupAtomic(db, groupId, userId) {
  const groupRef = doc(db, "groups", groupId);
  const userRef = doc(db, "users", userId);

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(groupRef);
    if (!snap.exists()) throw new Error("Group does not exist.");
    const group = snap.data();

    if (group.status === "finalized" || group.status === "completed" || group.status === "archived") {
      throw new Error("Cannot leave group after purchase finalization.");
    }

    const memberLeaving = group.members?.find((m) => m.uid === userId);
    if (!memberLeaving) throw new Error("You are not a member of this group.");
    if (memberLeaving.uid === group.creatorId || memberLeaving.uid === group.ownerId) {
      throw new Error("Creator cannot leave their own group; cancel the group or transfer ownership instead.");
    }

    const updatedMembers = group.members.filter((m) => m.uid !== userId);
    const updatedMemberIds = group.memberIds.filter((id) => id !== userId);
    const newTotal = updatedMembers.reduce((sum, m) => sum + Number(m.amount || 0), 0);

    txn.update(groupRef, {
      members: updatedMembers,
      memberIds: updatedMemberIds,
      acceptedCartValue: newTotal,
      totalCart: newTotal
    });

    txn.update(userRef, { activeGroupId: null });

    return { groupId, memberName: memberLeaving.name, creatorId: group.creatorId || group.ownerId };
  });
}

/**
 * Creator removes a member before finalization (Spec Section 16).
 */
export async function removeMemberAtomic(db, groupId, creatorUserId, memberUidToKick, reasonText = "Creator removed member") {
  const groupRef = doc(db, "groups", groupId);
  const kickedUserRef = doc(db, "users", memberUidToKick);

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(groupRef);
    if (!snap.exists()) throw new Error("Group does not exist.");
    const group = snap.data();

    if (group.creatorId !== creatorUserId && group.ownerId !== creatorUserId) {
      throw new Error("Only the creator can remove members.");
    }
    if (memberUidToKick === group.creatorId || memberUidToKick === group.ownerId) {
      throw new Error("Creator cannot be removed.");
    }

    if (group.status === "finalized" || group.status === "completed" || group.status === "archived") {
      throw new Error("Cannot remove members after purchase finalization.");
    }

    const memberToRemove = group.members?.find((m) => m.uid === memberUidToKick);
    if (!memberToRemove) throw new Error("Member is not in this group.");

    const updatedMembers = group.members.filter((m) => m.uid !== memberUidToKick);
    const updatedMemberIds = group.memberIds.filter((id) => id !== memberUidToKick);
    const newTotal = updatedMembers.reduce((sum, m) => sum + Number(m.amount || 0), 0);

    txn.update(groupRef, {
      members: updatedMembers,
      memberIds: updatedMemberIds,
      acceptedCartValue: newTotal,
      totalCart: newTotal
    });

    txn.update(kickedUserRef, { activeGroupId: null });

    return { groupId, removedMemberName: memberToRemove.name, memberUidToKick, reasonText };
  });
}
