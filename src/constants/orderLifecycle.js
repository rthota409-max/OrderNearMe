// Authoritative Order, Request, Group & Notification Lifecycle Definitions
// Conforms to OrderNearMe Master Project Specification

export const ORDER_STATUS = {
  // Active/Open states:
  WAITING: "waiting",                       // Open on feed accepting join requests (alias: 'open')
  OPEN: "open",                             // Backward-compatible alias for WAITING
  SCHEDULED: "scheduled",                   // Scheduled for future purchase date/time
  READY_TO_CLOSE: "ready_to_close",         // Target cart reached; creator prompted to close
  MATCHED: "matched",                       // 1+ requesters accepted, coordinating before close

  // Closed & Post-Close states:
  CLOSED: "closed",                         // Order closed by creator; group created
  CHECKOUT: "checkout",                     // Group locked for retailer breakdown entry
  ORDERED: "ordered",                       // Placed with retailer app
  DELIVERED: "delivered",                   // Items handed over at pickup point

  // Terminal & Alternate states:
  CLOSED_WITHOUT_GROUP: "closed_without_group", // Closed without any accepted members
  EXPIRED: "expired",                       // Timer expired without closing or matching
  ALONE: "alone",                           // Creator chose to order alone on retailer app
  CANCELLED: "cancelled",                   // Creator cancelled order
  COMPLETED: "completed",                   // Entire lifecycle completed (read-only archive)
  DISPUTED: "disputed"                      // Dispute flagged
};

export const REQUEST_STATUS = {
  PENDING: "pending",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  WITHDRAWN: "withdrawn",                   // Withdrawn voluntarily by requester
  EXPIRED: "expired",                       // Expired when order expired or closed without them
  AUTO_WITHDRAWN: "auto_withdrawn"          // Auto-withdrawn because requester was accepted into another order
};

// Backward-compatible alias:
export const JOIN_STATUS = {
  ...REQUEST_STATUS,
  REMOVED: "removed",
  LEFT: "left"
};

export const GROUP_STATUS = {
  ACTIVE: "active",                         // 60-minute active coordination window
  FINALIZED: "finalized",                   // Order locked/placed externally
  COMPLETED: "completed",                   // Items handed over, settlement acknowledged
  CANCELLED: "cancelled",                   // Group cancelled before completion
  EXPIRED: "expired",                       // 60-minute window passed without completion
  ARCHIVED: "archived"                      // Moved to history, chat strictly read-only
};

export const NOTIFICATION_TYPES = {
  JOIN_REQUEST_RECEIVED: "JOIN_REQUEST_RECEIVED",
  JOIN_REQUEST_ACCEPTED: "JOIN_REQUEST_ACCEPTED",
  JOIN_REQUEST_REJECTED: "JOIN_REQUEST_REJECTED",
  JOIN_REQUEST_WITHDRAWN: "JOIN_REQUEST_WITHDRAWN",
  AUTO_WITHDRAWAL: "AUTO_WITHDRAWAL",
  CART_TARGET_REACHED: "CART_TARGET_REACHED",
  REQUEST_EXPIRING: "REQUEST_EXPIRING",
  REQUEST_EXPIRED: "REQUEST_EXPIRED",
  ORDER_CLOSED: "ORDER_CLOSED",
  GROUP_CREATED: "GROUP_CREATED",
  MEMBER_LEFT: "MEMBER_LEFT",
  MEMBER_REMOVED: "MEMBER_REMOVED",
  GROUP_EXPIRING: "GROUP_EXPIRING",
  GROUP_ARCHIVED: "GROUP_ARCHIVED",
  GROUP_COMPLETED: "GROUP_COMPLETED"
};

export const PAYMENT_STATUS = {
  UNPAID: "unpaid",
  PAYMENT_REPORTED: "payment_reported",       // Self-reported by payer (personal UPI/Cash)
  PAYMENT_ACKNOWLEDGED: "payment_acknowledged" // Confirmed by recipient (Host)
};

export const REMOVAL_REASONS = [
  { id: "unresponsive", label: "Unresponsive in chat" },
  { id: "item_out_of_stock", label: "Requested item out of stock" },
  { id: "payment_declined", label: "Payment not sent or declined" },
  { id: "joiner_requested", label: "Joiner requested removal" },
  { id: "other", label: "Other" }
];

export const CANCELLATION_REASONS = [
  { id: "host_changed_mind", label: "Creator changed mind / ordering later" },
  { id: "store_closed", label: "Store closed" },
  { id: "platform_surge", label: "Platform surge fee or items out of stock" },
  { id: "other", label: "Other reason" }
];

// Valid lifecycle state machine transitions for Orders
const VALID_ORDER_TRANSITIONS = {
  [ORDER_STATUS.WAITING]: [
    ORDER_STATUS.READY_TO_CLOSE,
    ORDER_STATUS.MATCHED,
    ORDER_STATUS.CLOSED,
    ORDER_STATUS.CLOSED_WITHOUT_GROUP,
    ORDER_STATUS.EXPIRED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.ALONE
  ],
  [ORDER_STATUS.OPEN]: [
    ORDER_STATUS.READY_TO_CLOSE,
    ORDER_STATUS.MATCHED,
    ORDER_STATUS.CLOSED,
    ORDER_STATUS.CLOSED_WITHOUT_GROUP,
    ORDER_STATUS.EXPIRED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.ALONE
  ],
  [ORDER_STATUS.SCHEDULED]: [
    ORDER_STATUS.WAITING,
    ORDER_STATUS.OPEN,
    ORDER_STATUS.CLOSED,
    ORDER_STATUS.EXPIRED,
    ORDER_STATUS.CANCELLED
  ],
  [ORDER_STATUS.READY_TO_CLOSE]: [
    ORDER_STATUS.CLOSED,
    ORDER_STATUS.CLOSED_WITHOUT_GROUP,
    ORDER_STATUS.WAITING,
    ORDER_STATUS.CANCELLED
  ],
  [ORDER_STATUS.MATCHED]: [
    ORDER_STATUS.READY_TO_CLOSE,
    ORDER_STATUS.CLOSED,
    ORDER_STATUS.WAITING,
    ORDER_STATUS.OPEN,
    ORDER_STATUS.CHECKOUT,
    ORDER_STATUS.CANCELLED
  ],
  [ORDER_STATUS.CLOSED]: [
    ORDER_STATUS.COMPLETED,
    ORDER_STATUS.CANCELLED
  ],
  [ORDER_STATUS.CHECKOUT]: [
    ORDER_STATUS.ORDERED,
    ORDER_STATUS.MATCHED,
    ORDER_STATUS.CANCELLED
  ],
  [ORDER_STATUS.ORDERED]: [
    ORDER_STATUS.DELIVERED,
    ORDER_STATUS.DISPUTED
  ],
  [ORDER_STATUS.DELIVERED]: [
    ORDER_STATUS.COMPLETED,
    ORDER_STATUS.DISPUTED
  ],
  [ORDER_STATUS.DISPUTED]: [
    ORDER_STATUS.COMPLETED
  ],
  [ORDER_STATUS.EXPIRED]: [
    ORDER_STATUS.WAITING,
    ORDER_STATUS.OPEN
  ],
  [ORDER_STATUS.COMPLETED]: [],
  [ORDER_STATUS.ALONE]: [],
  [ORDER_STATUS.CANCELLED]: [],
  [ORDER_STATUS.CLOSED_WITHOUT_GROUP]: []
};

// Valid Group transitions
const VALID_GROUP_TRANSITIONS = {
  [GROUP_STATUS.ACTIVE]: [
    GROUP_STATUS.FINALIZED,
    GROUP_STATUS.COMPLETED,
    GROUP_STATUS.CANCELLED,
    GROUP_STATUS.EXPIRED
  ],
  [GROUP_STATUS.FINALIZED]: [
    GROUP_STATUS.COMPLETED,
    GROUP_STATUS.CANCELLED
  ],
  [GROUP_STATUS.COMPLETED]: [
    GROUP_STATUS.ARCHIVED
  ],
  [GROUP_STATUS.EXPIRED]: [
    GROUP_STATUS.ARCHIVED
  ],
  [GROUP_STATUS.CANCELLED]: [
    GROUP_STATUS.ARCHIVED
  ],
  [GROUP_STATUS.ARCHIVED]: []
};

export function isValidOrderTransition(currentStatus, nextStatus) {
  if (!currentStatus || !nextStatus) return false;
  if (currentStatus === nextStatus) return true;
  const allowed = VALID_ORDER_TRANSITIONS[currentStatus];
  return Array.isArray(allowed) && allowed.includes(nextStatus);
}

export function isValidGroupTransition(currentStatus, nextStatus) {
  if (!currentStatus || !nextStatus) return false;
  if (currentStatus === nextStatus) return true;
  const allowed = VALID_GROUP_TRANSITIONS[currentStatus];
  return Array.isArray(allowed) && allowed.includes(nextStatus);
}

/**
 * Single authoritative evaluator: is this order open for join requests on the public feed?
 */
export function getOrderJoinableStatus(order, nowMs = Date.now()) {
  if (!order) {
    return { joinable: false, reason: "Order not found", code: "NOT_FOUND" };
  }

  // 1. Terminal / Closed states
  if ([
    ORDER_STATUS.COMPLETED,
    ORDER_STATUS.CANCELLED,
    ORDER_STATUS.ALONE,
    ORDER_STATUS.CLOSED,
    ORDER_STATUS.CLOSED_WITHOUT_GROUP
  ].includes(order.status)) {
    return { joinable: false, reason: `Order is ${order.status}`, code: order.status.toUpperCase() };
  }

  if (order.status === ORDER_STATUS.CHECKOUT || order.status === ORDER_STATUS.ORDERED) {
    return { joinable: false, reason: "Locked for checkout", code: "LOCKED_FOR_CHECKOUT" };
  }

  // 2. Authoritative Timer Expiry
  const expiresAtMs = Number(order.expiresAtMs || order.requestExpiresAtMs || order.expiresAt || 0);
  if (expiresAtMs > 0 && expiresAtMs <= nowMs) {
    return { joinable: false, reason: "Timer expired", code: "EXPIRED" };
  }

  // 3. Member Cap (up to 6)
  const memberCount = Number(order.memberCount || 1);
  const maxMembers = Number(order.maxMembers || 6);
  if (memberCount >= maxMembers) {
    return { joinable: false, reason: `Member limit reached (${memberCount}/${maxMembers})`, code: "MEMBER_LIMIT_REACHED" };
  }

  // 4. Free delivery target reached
  const acceptedCart = Number(order.acceptedCartValue ?? order.currentCart ?? order.myAmount ?? 0);
  const targetAmount = Number(order.targetAmount || 199);
  if (acceptedCart >= targetAmount) {
    return { joinable: false, reason: `Free delivery target reached (₹${acceptedCart}/₹${targetAmount})`, code: "TARGET_REACHED" };
  }

  // 5. Maximum cart value ceiling reached (if set)
  if (order.maximumCartValue && acceptedCart >= Number(order.maximumCartValue)) {
    return { joinable: false, reason: `Maximum cart cap reached (₹${acceptedCart}/₹${order.maximumCartValue})`, code: "MAX_CART_REACHED" };
  }

  // 6. Valid joinable status
  const validJoinableStatuses = [
    ORDER_STATUS.WAITING,
    ORDER_STATUS.OPEN,
    ORDER_STATUS.SCHEDULED,
    ORDER_STATUS.MATCHED
  ];
  if (!validJoinableStatuses.includes(order.status)) {
    return { joinable: false, reason: `Order status is ${order.status}`, code: "INVALID_STATUS" };
  }

  return { joinable: true, reason: "Open for joining", code: "JOINABLE" };
}
