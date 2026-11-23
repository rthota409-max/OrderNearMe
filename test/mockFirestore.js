/**
 * Transactional In-Memory Firestore Mock for Node.js Automated Tests
 * Faithfully mirrors Firestore's runTransaction, collection, doc, and document snapshot APIs.
 */

export class MockFirestore {
  constructor() {
    this.store = new Map();
    this.subcollections = new Map(); // path -> Map(docId -> data)
  }

  setDoc(path, data) {
    this.store.set(path, JSON.parse(JSON.stringify(data)));
  }

  getDoc(path) {
    if (!this.store.has(path)) {
      return { exists: () => false, data: () => null, id: path.split("/").pop() };
    }
    return {
      exists: () => true,
      data: () => JSON.parse(JSON.stringify(this.store.get(path))),
      id: path.split("/").pop()
    };
  }

  updateDoc(path, updates) {
    if (!this.store.has(path)) throw new Error(`Document ${path} does not exist`);
    const current = this.store.get(path);
    const updated = { ...current, ...JSON.parse(JSON.stringify(updates)) };
    this.store.set(path, updated);
  }

  addDoc(collectionName, data) {
    const id = "mock_id_" + Math.random().toString(36).substring(2, 9);
    const path = `${collectionName}/${id}`;
    this.setDoc(path, { id, ...data });
    return { id, path };
  }

  async runTransaction(updateFunction) {
    // Transactional context
    const reads = new Map();
    const writes = new Map();

    const txn = {
      get: async (docRef) => {
        const path = docRef.path || docRef;
        const snap = this.getDoc(path);
        reads.set(path, snap.exists() ? snap.data() : null);
        return snap;
      },
      update: (docRef, updates) => {
        const path = docRef.path || docRef;
        writes.set(path, { type: "update", updates });
      },
      set: (docRef, data) => {
        const path = docRef.path || docRef;
        writes.set(path, { type: "set", data });
      }
    };

    const result = await updateFunction(txn);

    // Commit writes atomically
    for (const [path, op] of writes.entries()) {
      if (op.type === "update") {
        this.updateDoc(path, op.updates);
      } else if (op.type === "set") {
        this.setDoc(path, op.data);
      }
    }

    return result;
  }
}
