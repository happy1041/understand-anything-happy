"""Small isolated tests; do not touch the user's project."""
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest

SCRIPT = Path(__file__).parents[1] / 'scripts/catalog.py'
spec = importlib.util.spec_from_file_location('catalog', SCRIPT)
c = importlib.util.module_from_spec(spec)
spec.loader.exec_module(c)

class CatalogTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name).resolve()
        (self.root/'runs').mkdir()
        (self.root/'runs/example video.mp4').write_bytes(b'not-a-real-video')
        (self.root/'runs/manifest.json').write_text('{}')
        (self.root/'artifacts').mkdir()
        self.source = self.root/'artifacts/selected.json'
        self.item = dict(id='S01',stage='baseline',title='<demo> | [x]',kind='demo',roles=['presentation'],
                         path='runs/example video.mp4',manifest='runs/manifest.json',reason='test only',scope='not actually validated')
        self.save([self.item])
    def tearDown(self):
        self.temp.cleanup()
    def save(self, items, **kw):
        self.source.write_text(json.dumps(dict(schema_version=1,items=items,**kw)))
    def test_load_and_md_link(self):
        items=c.load_selected(self.root,self.source)
        text=c.render_md(self.root,self.source,self.root/'docs/ARTIFACTS.md',items)
        self.assertIn('../runs/example%20video.mp4',text)
        self.assertIn('\\|',text)
    def test_html_escaping(self):
        text=c.render_html(self.root,self.source,self.root/'docs/index.html',[self.item])
        self.assertNotIn('<demo>',text)
        self.assertIn('&lt;demo&gt;',text)
    def test_duplicate_rejected(self):
        self.save([self.item,self.item])
        with self.assertRaises(ValueError): c.load_selected(self.root,self.source)
    def test_example_rejected(self):
        self.save([self.item],template_only=True)
        with self.assertRaises(ValueError): c.load_selected(self.root,self.source)
    def test_missing_file_rejected(self):
        self.item['path']='missing.mp4';self.save([self.item])
        with self.assertRaises(ValueError): c.load_selected(self.root,self.source)
    def test_traversal_rejected(self):
        with self.assertRaises(ValueError): c.local_path(self.root,'../outside')
        with self.assertRaises(ValueError): c.local_path(self.root,'/tmp/file')
    def test_inventory_scoped(self):
        (self.root/'runs/.git').mkdir();(self.root/'runs/.git/hidden.mp4').write_bytes(b'x')
        d=c.inventory(self.root,['runs'],self.root/'artifacts/inventory.json',{'.mp4'},200)
        self.assertEqual(d['count'],1)
        self.assertTrue(d['complete_within_scope'])
    def test_inventory_partial(self):
        d=c.inventory(self.root,['missing','runs'],self.root/'artifacts/inventory.json',set(),1)
        self.assertEqual(d['count'],1)
        self.assertFalse(d['complete_within_scope'])
    def test_protect_handwritten_file(self):
        out=self.root/'report.md';out.write_text('# My notes')
        with self.assertRaises(ValueError): c.write_owned(out,'replacement','md')
        self.assertEqual(out.read_text(),'# My notes')
    def test_owned_file_rebuild(self):
        out=self.root/'docs/index.md'
        c.write_owned(out,c.MD_MARKER+'\nfirst','md')
        c.write_owned(out,c.MD_MARKER+'\nsecond','md')
        self.assertIn('second',out.read_text())
    def test_unassociated_legacy_visible(self):
        self.item['manifest']=None
        self.save([self.item])
        text=c.render_md(self.root,self.source,self.root/'docs/index.md',c.load_selected(self.root,self.source))
        self.assertIn('来源/验证记录未关联',text)
    def test_symlink_not_followed(self):
        (self.root/'runs/alias.mp4').symlink_to(self.root/'runs/example video.mp4')
        d=c.inventory(self.root,['runs'],self.root/'artifacts/inventory.json',{'.mp4'},200)
        self.assertEqual(d['count'],1)

if __name__=='__main__': unittest.main()
