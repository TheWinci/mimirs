# Verification

Use the following command to run the focused checks:

```sh
bun test tests/source-windows.test.ts
```

The command should preserve:

- exact source ranges;
- parent ownership;
- whitespace inside meaningful chunks.

## Example configuration

```yaml
reports:
  output: ./reports
  format: markdown
```

> Keep the source available so an agent can expand beyond a preview.
