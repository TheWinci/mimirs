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
