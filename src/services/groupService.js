/**
 * Authoritative Group Lifecycle & External Retailer Coordination Service
 * 
 * Conforms to OrderNearMe Master Project Specification:
 * - 60-Minute Group Lifecycle & Read-Only Archival.
 * - Explicit workflow states:
 *   1. Amount calculated (Estimated vs Confirmed zero-residual allocation)
 *   2. Payment self-reported by payer (Personal UPI/Cash)
 *   3. Payment acknowledged by host
 *   4. Retailer order placed
 *   5. Items handed over
 *   6. Order completed or disputed
 *   7. Ratings submitted post-completion into `ratings/{ratingId}`
 */

import {
  doc,
  collection,
  addDoc,
  setDoc,
  serverTimestamp,
  runTransaction
} from "firebase/firestore";
import {
  ORDER_STATUS,
  GROUP_STATUS,
  PAYMENT_STATUS,
  NOTIFICATION_TYPES,
  isValidOrderTransition,
  isValidGroupTransition
} from "../constants/orderLifecycle.js";
import { reconcileGroupBill } from "./billReconciliation.js";
import { sendNotification } from "./notificationService.js";

/**
 * Host locks order to enter exact retailer checkout breakdown.
 */
export async function lockOrderForCheckout(db, groupId, orderId, hostUserId) {
  const groupRef = doc(db, "groups", groupId);
  const orderRef = orderId ? doc(db, "orders", orderId) : null;

  return await runTransaction(db, async (txn) => {
    const groupSnap = await txn.get(groupRef);
    if (!groupSnap.exists()) throw new Error("Group does not exist.");
    const group = groupSnap.data();

    if (group.creatorId !== hostUserId && group.ownerId !== hostUserId) {
      throw new Error("Only the creator can lock this order.");
    }

    txn.update(groupRef, {
      status: GROUP_STATUS.FINALIZED,
      lockedAtMs: Date.now()
    });

    if (orderRef) {
      txn.update(orderRef, {
        status: ORDER_STATUS.CHECKOUT,
        lockedAtMs: Date.now()
      });
    }

    return { status: GROUP_STATUS.FINALIZED };
  });
}

/**
 * Host unlocks order before placing if revisions are needed.
 */
export async function unlockOrderFromCheckout(db, groupId, orderId, hostUserId) {
  const groupRef = doc(db, "groups", groupId);
  const orderRef = orderId ? doc(db, "orders", orderId) : null;

  return await runTransaction(db, async (txn) => {
    const groupSnap = await txn.get(groupRef);
    if (!groupSnap.exists()) throw new Error("Group does not exist.");
    const group = groupSnap.data();

    if (group.creatorId !== hostUserId && group.ownerId !== hostUserId) {
      throw new Error("Only the creator can unlock this order.");
    }

    txn.update(groupRef, {
      status: GROUP_STATUS.ACTIVE
    });

    if (orderRef) {
      txn.update(orderRef, {
        status: ORDER_STATUS.MATCHED
      });
    }

    return { status: GROUP_STATUS.ACTIVE };
  });
}

/**
 * Host enters and confirms the authoritative retailer checkout breakdown.
 * Recalculates exact shares for all members with zero-residual guarantee.
 */
export async function confirmCheckoutBreakdown(db, groupId, hostUserId, breakdownInput) {
  const groupRef = doc(db, "groups", groupId);

  return await runTransaction(db, async (txn) => {
    const groupSnap = await txn.get(groupRef);
    if (!groupSnap.exists()) throw new Error("Group does not exist.");
    const group = groupSnap.data();

    if (group.creatorId !== hostUserId && group.ownerId !== hostUserId) {
      throw new Error("Only the creator can enter the checkout breakdown.");
    }

    // Authoritative zero-residual bill reconciliation
    const reconciliation = reconcileGroupBill(group.members || [], {
      ...breakdownInput,
      isConfirmed: true
    }, group.targetCartValue || group.targetAmount || 199);

    const updatedMembers = (group.members || []).map((m) => {
      const breakdown = reconciliation.memberBreakdowns.find((b) => b.uid === m.uid);
      return {
        ...m,
        merchandiseAmount: breakdown?.merchandiseAmount ?? Number(m.amount || 0),
        feeShare: breakdown?.feeShare ?? 0,
        discountShare: breakdown?.discountShare ?? 0,
        finalAmountOwed: breakdown?.finalAmountOwed ?? Number(m.amount || 0)
      };
    });

    txn.update(groupRef, {
      members: updatedMembers,
      checkoutBreakdown: {
        deliveryFee: reconciliation.deliveryFee,
        handlingFee: reconciliation.handlingFee,
        packagingFee: reconciliation.packagingFee,
        surgeFee: reconciliation.surgeFee,
        discountAmount: reconciliation.discountAmount,
        totalFees: reconciliation.totalFees,
        finalCheckoutTotal: reconciliation.finalCheckoutTotal,
        isConfirmed: true,
        confirmedAtMs: Date.now()
      },
      acceptedCartValue: reconciliation.finalCheckoutTotal,
      totalCart: reconciliation.finalCheckoutTotal
    });

    return reconciliation;
  });
}

/**
 * Payer self-reports payment via offline / personal UPI transfer.
 */
export async function reportMemberPayment(db, groupId, userId, note = "") {
  const groupRef = doc(db, "groups", groupId);

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(groupRef);
    if (!snap.exists()) throw new Error("Group does not exist.");
    const group = snap.data();

    const member = group.members?.find((m) => m.uid === userId);
    if (!member) throw new Error("Member not in group.");

    const updatedMembers = group.members.map((m) => {
      if (m.uid === userId) {
        return {
          ...m,
          paymentStatus: PAYMENT_STATUS.PAYMENT_REPORTED,
          isPaid: true,
          paymentReportedAtMs: Date.now(),
          paymentNote: (note || "").trim()
        };
      }
      return m;
    });

    txn.update(groupRef, { members: updatedMembers });
    return { memberName: member.name, amount: member.finalAmountOwed || member.amount };
  });
}

/**
 * Host acknowledges receipt of a member's payment.
 */
export async function acknowledgeMemberPayment(db, groupId, hostUserId, memberUid) {
  const groupRef = doc(db, "groups", groupId);

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(groupRef);
    if (!snap.exists()) throw new Error("Group does not exist.");
    const group = snap.data();

    if (group.creatorId !== hostUserId && group.ownerId !== hostUserId) {
      throw new Error("Only the host can acknowledge payments.");
    }

    const updatedMembers = group.members.map((m) => {
      if (m.uid === memberUid) {
        return {
          ...m,
          paymentStatus: PAYMENT_STATUS.PAYMENT_ACKNOWLEDGED,
          hostConfirmed: true,
          acknowledgedAtMs: Date.now()
        };
      }
      return m;
    });

    txn.update(groupRef, { members: updatedMembers });
    const member = group.members?.find((m) => m.uid === memberUid);
    return { memberName: member?.name || "Member" };
  });
}

/**
 * Host marks order as placed externally with retailer.
 */
export async function markRetailerOrderPlaced(db, groupId, orderId, hostUserId) {
  const groupRef = doc(db, "groups", groupId);
  const orderRef = orderId ? doc(db, "orders", orderId) : null;

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(groupRef);
    if (!snap.exists()) throw new Error("Group does not exist.");
    const group = snap.data();

    if (group.creatorId !== hostUserId && group.ownerId !== hostUserId) {
      throw new Error("Only the creator can mark the order as placed.");
    }

    txn.update(groupRef, {
      status: GROUP_STATUS.FINALIZED,
      orderedAtMs: Date.now()
    });

    if (orderRef) {
      txn.update(orderRef, {
        status: ORDER_STATUS.ORDERED,
        orderedAtMs: Date.now()
      });
    }

    return { status: GROUP_STATUS.FINALIZED };
  });
}

/**
 * Host marks items as handed over at pickup point.
 */
export async function markItemsHandedOver(db, groupId, orderId, hostUserId) {
  const groupRef = doc(db, "groups", groupId);
  const orderRef = orderId ? doc(db, "orders", orderId) : null;

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(groupRef);
    if (!snap.exists()) throw new Error("Group does not exist.");
    const group = snap.data();

    if (group.creatorId !== hostUserId && group.ownerId !== hostUserId) {
      throw new Error("Only the creator can mark items as handed over.");
    }

    txn.update(groupRef, {
      deliveredAtMs: Date.now()
    });

    if (orderRef) {
      txn.update(orderRef, {
        status: ORDER_STATUS.DELIVERED,
        deliveredAtMs: Date.now()
      });
    }

    return { status: ORDER_STATUS.DELIVERED };
  });
}

/**
 * Joiner confirms receipt of their items.
 */
export async function confirmMemberReceipt(db, groupId, userId) {
  const groupRef = doc(db, "groups", groupId);

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(groupRef);
    if (!snap.exists()) throw new Error("Group does not exist.");
    const group = snap.data();

    const updatedMembers = group.members.map((m) => {
      if (m.uid === userId) {
        return { ...m, receiptConfirmed: true, receiptConfirmedAtMs: Date.now() };
      }
      return m;
    });

    txn.update(groupRef, { members: updatedMembers });
    return { success: true };
  });
}

/**
 * Report a problem / dispute.
 */
export async function reportProblemDispute(db, groupId, orderId, userId, reason) {
  const groupRef = doc(db, "groups", groupId);
  const orderRef = orderId ? doc(db, "orders", orderId) : null;

  return await runTransaction(db, async (txn) => {
    txn.update(groupRef, {
      status: GROUP_STATUS.FINALIZED,
      disputeReason: reason,
      disputedBy: userId,
      disputedAtMs: Date.now()
    });

    if (orderRef) {
      txn.update(orderRef, {
        status: ORDER_STATUS.DISPUTED,
        disputeReason: reason,
        disputedAtMs: Date.now()
      });
    }

    return { status: ORDER_STATUS.DISPUTED };
  });
}

/**
 * Completes the order group (Spec Section 19).
 * - Lifecycle reaches terminal COMPLETED / ARCHIVED state.
 * - Chat becomes read-only.
 * - Clears activeGroupId pointers on all members.
 */
export async function completeOrderGroup(db, groupId, orderId, hostUserId) {
  const groupRef = doc(db, "groups", groupId);
  const orderRef = orderId ? doc(db, "orders", orderId) : null;

  const result = await runTransaction(db, async (txn) => {
    const snap = await txn.get(groupRef);
    if (!snap.exists()) throw new Error("Group does not exist.");
    const group = snap.data();

    if (group.creatorId !== hostUserId && group.ownerId !== hostUserId) {
      throw new Error("Only the creator can complete this order.");
    }
    if (group.status === GROUP_STATUS.COMPLETED || group.status === GROUP_STATUS.ARCHIVED) {
      throw new Error("Order is already completed.");
    }

    const now = Date.now();

    txn.update(groupRef, {
      status: GROUP_STATUS.COMPLETED,
      completedAtMs: now,
      archivedAtMs: now
    });

    if (orderRef) {
      txn.update(orderRef, {
        status: ORDER_STATUS.COMPLETED,
        completedAtMs: now
      });
    }

    // Reset active pointers for all members
    for (const memberId of (group.memberIds || [])) {
      const uRef = doc(db, "users", memberId);
      txn.update(uRef, {
        activeGroupId: null,
        activeOrderId: null
      });
    }

    return {
      status: GROUP_STATUS.COMPLETED,
      memberIds: group.memberIds || []
    };
  });

  // Post-completion notifications
  for (const uid of result.memberIds) {
    await sendNotification(db, {
      recipientId: uid,
      type: NOTIFICATION_TYPES.GROUP_COMPLETED,
      title: "Order Completed! 🎉",
      body: "Your order group has completed successfully. Rate your pool mates to boost their trust score!",
      groupId,
      orderId
    });
  }

  return result;
}

/**
 * Authoritatively archives an expired group after 60 minutes (Spec Section 19).
 */
export async function archiveExpiredGroupAtomic(db, groupId) {
  const groupRef = doc(db, "groups", groupId);

  return await runTransaction(db, async (txn) => {
    const snap = await txn.get(groupRef);
    if (!snap.exists()) return null;
    const group = snap.data();

    if (group.status === GROUP_STATUS.ARCHIVED) return null;
    const now = Date.now();
    if (now < Number(group.expiresAtMs || 0)) return null;

    const orderRef = group.orderId ? doc(db, "orders", group.orderId) : null;
    const orderSnap = orderRef ? await txn.get(orderRef) : null;

    txn.update(groupRef, {
      status: GROUP_STATUS.ARCHIVED,
      archivedAtMs: now
    });

    if (orderRef && orderSnap?.exists()) {
      txn.update(orderRef, {
        status: ORDER_STATUS.COMPLETED,
        completedAtMs: now
      });
    }

    for (const memberId of (group.memberIds || [])) {
      const uRef = doc(db, "users", memberId);
      txn.update(uRef, {
        activeGroupId: null,
        activeOrderId: null
      });
    }

    return { groupId, status: GROUP_STATUS.ARCHIVED };
  });
}

/**
 * Submits a verified user rating into `ratings/{ratingId}` (Spec Section 21).
 * Restricts:
 * - Reviewer cannot rate themselves.
 * - Rating can only be submitted after group interaction completes.
 * - Prevents duplicate ratings for the same interaction.
 */
export async function submitUserRating(db, {
  reviewerId,
  reviewerName,
  reviewedUserId,
  groupId,
  rating,
  review = ""
}) {
  if (!reviewerId || !reviewedUserId || !groupId) {
    throw new Error("Reviewer, target user, and group ID are required.");
  }
  if (reviewerId === reviewedUserId) {
    throw new Error("You cannot submit a rating for yourself.");
  }

  const numRating = Number(rating);
  if (isNaN(numRating) || numRating < 1 || numRating > 5) {
    throw new Error("Rating must be between 1 and 5 stars.");
  }

  const ratingDocId = `${groupId}_${reviewerId}_${reviewedUserId}`;
  const ratingRef = doc(db, "ratings", ratingDocId);
  const groupRef = doc(db, "groups", groupId);
  const targetUserRef = doc(db, "users", reviewedUserId);

  return await runTransaction(db, async (txn) => {
    const existingRatingSnap = await txn.get(ratingRef);
    if (existingRatingSnap.exists()) {
      throw new Error("You have already submitted a rating for this user for this order.");
    }

    const groupSnap = await txn.get(groupRef);
    if (!groupSnap.exists()) throw new Error("Order group does not exist.");
    const group = groupSnap.data();

    // Verify interaction is completed or archived
    if (group.status !== GROUP_STATUS.COMPLETED && group.status !== GROUP_STATUS.ARCHIVED) {
      throw new Error("Ratings can only be submitted after an order group completes.");
    }

    // Verify both were active members
    if (!group.memberIds?.includes(reviewerId) || !group.memberIds?.includes(reviewedUserId)) {
      throw new Error("Both users must be members of this order group to submit ratings.");
    }

    const targetUserSnap = await txn.get(targetUserRef);
    const targetUser = targetUserSnap.exists() ? targetUserSnap.data() : {};

    const curCount = Number(targetUser.ratingCount || 0);
    const curSum = Number(targetUser.ratingSum || (curCount * 5.0));
    const newCount = curCount + 1;
    const newSum = curSum + numRating;
    const newAverage = Number((newSum / newCount).toFixed(1));

    const ratingData = {
      id: ratingDocId,
      reviewerId,
      reviewerName: reviewerName || "Hostel Mate",
      reviewedUserId,
      groupId,
      rating: numRating,
      review: (review || "").trim(),
      createdAtMs: Date.now(),
      createdAt: serverTimestamp()
    };

    txn.set(ratingRef, ratingData);

    txn.update(targetUserRef, {
      ratingCount: newCount,
      ratingSum: newSum,
      ratingAverage: newAverage,
      updatedAtMs: Date.now()
    });

    return ratingData;
  });
}
