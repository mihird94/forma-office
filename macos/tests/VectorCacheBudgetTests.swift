import Foundation

@main struct VectorCacheBudgetTests {
    static func main() {
        var cache = FormaVectorCacheBudget(limitBytes: 100)
        precondition(cache.admit("a", bytes: 40).stored)
        precondition(cache.admit("b", bytes: 40).stored)
        cache.touch("a")
        let admission = cache.admit("c", bytes: 30)
        precondition(admission.stored && admission.evicted == ["b"] && cache.usedBytes == 70)
        let oversized = cache.admit("large", bytes: 101)
        precondition(!oversized.stored && oversized.evicted.isEmpty && cache.usedBytes == 70)
        let replace = cache.admit("a", bytes: 60)
        precondition(replace.stored && cache.usedBytes == 90)
        var emptyEntries = FormaVectorCacheBudget(limitBytes: 100, maxEntries: 2)
        _ = emptyEntries.admit("x", bytes: 0)
        _ = emptyEntries.admit("y", bytes: 0)
        precondition(emptyEntries.admit("z", bytes: 0).evicted == ["x"])
        print("Vector cache budget tests passed")
    }
}
