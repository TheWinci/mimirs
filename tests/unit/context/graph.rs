use super::*;
fn id(n: u128) -> KnowledgeId {
    KnowledgeId(uuid::Uuid::from_u128(n + 1))
}
#[test]
fn deep_graphs_preserve_cycle_reachability_and_converging_dags() {
    let n = 50_000;
    let mut graph = (0..n)
        .map(|i| {
            (
                id(i),
                if i + 1 < n {
                    BTreeSet::from([id(i + 1)])
                } else {
                    BTreeSet::new()
                },
            )
        })
        .collect::<BTreeMap<_, _>>();
    assert!(reaches_cycles(&graph).is_empty());
    graph.insert(id(n - 1), BTreeSet::from([id(n - 10)]));
    assert_eq!(reaches_cycles(&graph).len(), n as usize);
    let merging = BTreeMap::from([
        (id(0), BTreeSet::from([id(1), id(2)])),
        (id(1), BTreeSet::from([id(3)])),
        (id(2), BTreeSet::from([id(3)])),
        (id(3), BTreeSet::new()),
    ]);
    assert!(reaches_cycles(&merging).is_empty());
}
