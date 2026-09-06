"""Check that the frozen reference exercises the distinctions needed by the port."""
import json
import math
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest

HERE = Path(__file__).resolve().parent


def utf16_slice(text, start, end):
    return text.encode('utf-16-le')[start * 2:end * 2].decode('utf-16-le')


class PortReferenceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.reference = json.loads((HERE / 'port/reference.json').read_text())

    def test_native_completion_adds_only_union_candidates(self):
        cases = self.reference['nativeCases']
        extended = False
        for case in cases:
            before, after = case['baseline'], case['completed']
            union = {c['id'] for channel in ('semantic', 'lexical') for c in before[channel]}
            for channel in ('semantic', 'lexical'):
                ids = [c['id'] for c in after[channel]]
                self.assertEqual(len(ids), len(set(ids)))
                self.assertTrue(set(ids) <= union)
                extended |= len(ids) > len(before[channel])
        self.assertTrue(extended, 'fixture must exercise score completion beyond initial limits')

    def test_native_bm25_is_not_the_in_memory_reference(self):
        differences = []
        for case in self.reference['nativeCases']:
            memory = {row['id']: row['score'] for row in case['referenceLexical']}
            for row in case['baseline']['lexical']:
                if row['id'] in memory:
                    differences.append(not math.isclose(memory[row['id']], row['lexicalScore']))
        self.assertTrue(any(differences))

    def test_keyword_hit_without_a_vector_survives(self):
        case = next(c for c in self.reference['nativeCases'] if c['request']['query'] == 'lexicalOnly')
        self.assertIn('src/unembedded.ts', [h['path'] for h in case['candidates']['results']])
        self.assertNotIn('src/unembedded.ts', [h['path'] for h in case['completed']['semantic']])

    def test_grouping_uses_independent_best_ranks(self):
        group = self.reference['groupedCases']
        combined = next(h for h in group['chunks'] if len(h['windows']) == 2)
        # The strongest semantic and lexical ranks belong to different windows.
        self.assertAlmostEqual(combined['score'], 1.0, delta=self.reference['tolerances']['scalar_absolute'])
        self.assertEqual(len(group['files']), 1)
        self.assertGreater(group['files'][0]['score'], combined['score'])
        self.assertEqual(len(group['files'][0]['windows']), 3)

    def test_source_ranges_are_utf16_and_preserve_full_text(self):
        sources = {f['path']: f['normalizedSource'] for f in self.reference['files']}
        sources.update({f['path']: f['normalizedSource'] for f in self.reference['sourceCases']})
        windows = self.reference['windows'] + [w for f in self.reference['sourceCases'] for w in f['windows']]
        unicode_offset_differs = False
        for window in windows:
            text = sources[window['path']]
            start, end = window['startOffset'], window['endOffset']
            self.assertEqual(utf16_slice(text, start, end), window['text'])
            unicode_offset_differs |= len(window['text'].encode()) != end - start
        self.assertTrue(unicode_offset_differs)
        unicode_file = next(f for f in self.reference['files'] if f['path'] == 'src/unicode.ts')
        self.assertTrue(unicode_file['source'].startswith('\ufeff'))
        self.assertFalse(unicode_file['normalizedSource'].startswith('\ufeff'))
        self.assertIn('\r\n', unicode_file['source'])
        self.assertNotIn('\r', unicode_file['normalizedSource'])
        large = next(f for f in self.reference['sourceCases'] if f['path'] == 'src/large.rs')
        self.assertGreater(len(large['windows']), 1)
        self.assertEqual(''.join(w['text'] for w in large['windows']), large['source'])

    def test_final_token_inputs_repeat_path_and_preserve_source_spelling(self):
        short, long = self.reference['tokenInputs']
        self.assertEqual(len(short['windows']), 1)
        self.assertGreater(len(long['windows']), 1)
        for case in (short, long):
            prefix, source = case['text'].split('\n', 1)
            for window in case['windows']:
                self.assertTrue(window['text'].startswith(prefix + '\n'))
                self.assertIn(window['text'][len(prefix) + 1:], source)
                self.assertLessEqual(len(window['ids']), 256)
        self.assertTrue(all('KeepLiteral_Case' in w['text'] for w in long['windows']))

    def test_document_reference_expansion_is_captured(self):
        relations = [r for c in self.reference['nativeCases'] for r in c['segmented']['relations']]
        self.assertTrue(any(r['documentPath'] == 'docs/usage.md' and r['sourcePath'] == 'src/alpha.ts' for r in relations))

    @unittest.skipUnless(shutil.which('bun'), 'Bun is needed to exercise the reference-source guard')
    def test_exporter_rejects_changed_reference_before_importing_it(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / 'bun.lock').write_text('changed reference lock\n')
            output = root / 'unexpected.json'
            result = subprocess.run(['bun', str(HERE / 'port-reference.ts'), str(root), str(output)], capture_output=True, text=True)
            self.assertNotEqual(result.returncode, 0)
            self.assertIn('reference differs from', result.stderr)
            self.assertFalse(output.exists())


if __name__ == '__main__':
    unittest.main()
