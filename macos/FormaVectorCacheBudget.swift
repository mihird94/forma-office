import Foundation

/// Bookkeeping for retained cache memory; callers synchronize access.
struct FormaVectorCacheBudget {
    let limitBytes: Int
    let maxEntries: Int
    private(set) var usedBytes = 0
    private var sizes: [String: Int] = [:]
    private var order: [String] = []

    init(limitBytes: Int = 256 * 1024 * 1024, maxEntries: Int = 4) {
        self.limitBytes = max(0, limitBytes)
        self.maxEntries = max(1, maxEntries)
    }

    mutating func touch(_ key: String) {
        guard sizes[key] != nil else { return }
        order.removeAll { $0 == key }
        order.append(key)
    }

    /// Returns whether the entry fits and the keys to remove from the actual cache.
    mutating func admit(_ key: String, bytes: Int) -> (stored: Bool, evicted: [String]) {
        guard bytes >= 0, bytes <= limitBytes else { return (false, []) }
        var evicted: [String] = []
        if let old = sizes.removeValue(forKey: key) { usedBytes -= old; order.removeAll { $0 == key } }
        while (usedBytes > limitBytes - bytes || order.count >= maxEntries), let oldest = order.first {
            order.removeFirst()
            if let size = sizes.removeValue(forKey: oldest) { usedBytes -= size; evicted.append(oldest) }
        }
        sizes[key] = bytes
        usedBytes += bytes
        order.append(key)
        return (true, evicted)
    }
}
