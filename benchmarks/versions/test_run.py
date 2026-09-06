import unittest
from pathlib import Path
from run import edit_files, relative_path, score, unique_paths


class ScoringTests(unittest.TestCase):
    def test_multiple_expected_files_and_duplicate_owners(self):
        queries = [{'query':'q','expected':['a.ts','b.ts']}]
        hits = [{'path':p} for p in ['other.ts','a.ts','a.ts','b.ts']]
        result = score(queries,[{'pass':0,'index':0,'hits':hits}],{})
        self.assertEqual(result['mrr@20'],0.5)
        self.assertEqual(result['recall@5'],1)
        self.assertEqual(result['cases'][0]['paths'],['other.ts','a.ts','b.ts'])

    def test_recall_is_fraction_of_expected_files(self):
        queries = [{'query':'q','expected':['a.ts','b.ts']}]
        result = score(queries,[{'pass':0,'index':0,'hits':[{'path':'a.ts'}]}],{})
        self.assertEqual(result['recall@20'],0.5)
        self.assertEqual(result['misses@20'],0)

    def test_explicit_rename_and_cutoff(self):
        queries = [{'query':'q','expected':['old.ts']}]
        hits = [{'path':f'{i}.ts'} for i in range(20)] + [{'path':'new.ts'}]
        result = score(queries,[{'pass':0,'index':0,'hits':hits}],{'old.ts':'new.ts'})
        self.assertEqual(result['mrr@20'],0)
        self.assertEqual(result['misses@20'],1)

    def test_edits_use_queried_files_instead_of_larger_generated_assets(self):
        manifest={'expected_path_corrections':{'old.ts':'b.ts'},'manifest':[
            {'path':'generated.ts','bytes':10000},{'path':'a.ts','bytes':30},
            {'path':'b.ts','bytes':40},{'path':'c.ts','bytes':10}]}
        queries=[{'expected':['a.ts','old.ts','c.ts']}]
        self.assertEqual([f['path'] for f in edit_files(manifest,queries)],['b.ts','a.ts'])

    def test_absolute_paths_require_correct_root(self):
        self.assertEqual(relative_path('/tmp/example/src/a.ts',Path('/tmp/example')),'src/a.ts')
        with self.assertRaises(ValueError): relative_path('/elsewhere/a.ts',Path('/tmp/example'))
        with self.assertRaises(ValueError): relative_path('../a.ts')
        with self.assertRaises(ValueError): relative_path('/tmp/example/a.ts')

    def test_timing_repeats_do_not_change_quality_denominator(self):
        queries = [{'query':'q','expected':['a.ts']}]
        cases = [{'pass':p,'index':0,'hits':[{'path':'a.ts'}]} for p in range(3)]
        self.assertEqual(score(queries,cases,{})['queries'],1)


if __name__ == '__main__': unittest.main()
