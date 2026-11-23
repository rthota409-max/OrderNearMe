/**
 * One-time Firestore cleanup script.
 * Deletes ALL documents from: orders, joinRequests, groups, notifications, ratings, reports
 * Run with: node cleanup-firestore.js
 */
import { initializeApp } from "firebase/app";
import { getFirestore, collection, getDocs, deleteDoc, doc, writeBatch } from "firebase/firestore";

const firebaseConfig = {
  apiKey: "AIzaSyDiCWAPtMH4WHu5pWf9As26JefOwEkhnNc",
  authDomain: "ordernearme-8e448.firebaseapp.com",
  projectId: "ordernearme-8e448",
  storageBucket: "ordernearme-8e448.firebasestorage.app",
  messagingSenderId: "852492175692",
  appId: "1:852492175692:web:61817b298a52cd6a15a7e9"
};

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);

const COLLECTIONS_TO_CLEAN = [
  "orders",
  "joinRequests",
  "groups",
  "notifications",
  "ratings",
  "reports"
];

async function deleteCollection(collName) {
  console.log(`Cleaning ${collName}...`);
  const snap = await getDocs(collection(db, collName));
  if (snap.empty) {
    console.log(`  ${collName}: already empty`);
    return 0;
  }

  let count = 0;
  // Use batched deletes (max 500 per batch)
  let batch = writeBatch(db);
  let batchCount = 0;

  for (const docSnap of snap.docs) {
    // If it's groups, also delete subcollection messages
    if (collName === "groups") {
      try {
        const msgsSnap = await getDocs(collection(db, "groups", docSnap.id, "messages"));
        for (const msgDoc of msgsSnap.docs) {
          await deleteDoc(doc(db, "groups", docSnap.id, "messages", msgDoc.id));
        }
        if (msgsSnap.size > 0) console.log(`  Deleted ${msgsSnap.size} messages from group ${docSnap.id}`);
      } catch (e) {
        console.log(`  Could not delete messages for group ${docSnap.id}: ${e.message}`);
      }
    }

    batch.delete(doc(db, collName, docSnap.id));
    batchCount++;
    count++;

    if (batchCount >= 450) {
      await batch.commit();
      batch = writeBatch(db);
      batchCount = 0;
    }
  }

  if (batchCount > 0) {
    await batch.commit();
  }

  console.log(`  ${collName}: deleted ${count} documents`);
  return count;
}

async function resetUserPointers() {
  console.log("Resetting user activeOrderId and activeGroupId...");
  const snap = await getDocs(collection(db, "users"));
  let batch = writeBatch(db);
  let count = 0;

  for (const docSnap of snap.docs) {
    const data = docSnap.data();
    if (data.activeOrderId || data.activeGroupId) {
      batch.update(doc(db, "users", docSnap.id), {
        activeOrderId: null,
        activeGroupId: null
      });
      count++;
    }
  }

  if (count > 0) {
    await batch.commit();
    console.log(`  Reset ${count} user pointers`);
  } else {
    console.log(`  No user pointers to reset`);
  }
}

async function main() {
  console.log("=== OrderNearMe Firestore Data Cleanup ===\n");

  let total = 0;
  for (const coll of COLLECTIONS_TO_CLEAN) {
    total += await deleteCollection(coll);
  }

  await resetUserPointers();

  console.log(`\n=== Done! Deleted ${total} total documents. Firestore is clean. ===`);
  process.exit(0);
}

main().catch((e) => {
  console.error("Cleanup failed:", e);
  process.exit(1);
});
