<!-- Exemplar: adapt to this project. Every row and example must come
     from actual names in the codebase — no hypothetical "FooBar"
     placeholders. If a convention is not visible in the code, skip
     that section entirely rather than inventing one. -->

# Conventions

Patterns and conventions observed across the codebase.

## Naming

| Element | Convention | Example |
|---------|-----------|---------|
| Files | <pattern> | `<actual filename>` |
| Functions | <pattern> | `<actual function>` |
| Types/Interfaces | <pattern> | `<actual type>` |
| Constants | <pattern> | `<actual constant>` |
| Test files | <pattern> | `<actual test filename>` |

## File Organization

<!-- adapt: observe from the codebase. How do files start — imports
     first, then types, then functions? Do modules have an `index.ts`
     that re-exports? Are barrel files used? Describe what is actually
     there. -->

<1-2 paragraphs describing the observed file shape.>

## Error Handling

<!-- adapt: only if the project has a consistent pattern. Throw? Return
     Result? Callback? If it is inconsistent, skip this section rather
     than prescribing one. -->

<Paragraph describing the pattern, with a short example from the code.>

```<lang>
<short, real error-handling snippet>
```

## Common Patterns

<!-- adapt: include only patterns that repeat across ≥3 modules. Skip
     if nothing qualifies. -->

### <Pattern name>

<Description. Where it's used. Why.>

```<lang>
<short example>
```

## Import Conventions

<!-- adapt: observe from source. Stdlib → external → internal? Barrel
     files or direct imports? Alias paths? Skip if there's no visible
     style. -->

<Short paragraph describing the observed import style.>

## See also

- [Architecture](../architecture.md)
- [Testing](testing.md)
