#[test]
fn javascript_typescript_and_tsx_grammars_load() {
    for (language, source) in [
        (
            tree_sitter_javascript::LANGUAGE.into(),
            "export default class { #x = 1; field = () => <div/>; get value() { return this.#x; } }",
        ),
        (
            tree_sitter_typescript::LANGUAGE_TYPESCRIPT.into(),
            "declare namespace A.B { export const value: string; }\n/** docs */\n@sealed export abstract class Box<T> { @cache public field = (x: T): T => x; abstract run(x: T): T; run(x: T): T; run(x: T): T { return x; } }\nexport default function () {}\nexport default class {}\nexport default () => 1;",
        ),
        (
            tree_sitter_typescript::LANGUAGE_TSX.into(),
            "export const View = <T,>(props: T) => <section>{String(props)}</section>;",
        ),
    ] {
        let mut parser = tree_sitter::Parser::new();
        parser.set_language(&language).unwrap();
        let tree = parser.parse(source, None).unwrap();
        assert!(!tree.root_node().has_error(), "{source}");
    }
}

#[test]
fn go_grammar_loads_with_generic_declarations_and_receivers() {
    let source = "package cache\ntype Box[T any] struct { Value T }\ntype Alias[T any] = Box[T]\nfunc (b *Box[T]) Get() T { return b.Value }\nconst (\nFirst = iota; Second\n)\nvar (\na, b = 1, 2\n)\nfunc external(x int) int\n";
    let mut parser = tree_sitter::Parser::new();
    parser
        .set_language(&tree_sitter_go::LANGUAGE.into())
        .unwrap();
    let tree = parser.parse(source, None).unwrap();
    assert!(
        !tree.root_node().has_error(),
        "{}",
        tree.root_node().to_sexp()
    );
}
