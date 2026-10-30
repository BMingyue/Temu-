import json
import sqlite3
import unittest
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
import price_window


class PriceWindowTests(unittest.TestCase):
    def setUp(self):
        self.db = sqlite3.connect(':memory:')
        self.db.row_factory = sqlite3.Row
        self.db.executescript('CREATE TABLE activity_settings(id TEXT,payload TEXT); CREATE TABLE collector_shops(mall_id TEXT,name TEXT); CREATE TABLE activity_evidence_snapshots(captured TEXT,mall_id TEXT,campaign_id TEXT,payload TEXT);')
        self.db.execute('INSERT INTO collector_shops VALUES(?,?)', ('123','测试店'))
        self.db.execute('INSERT INTO activity_settings VALUES(?,?)', ('active_preset:123',json.dumps('毛毯')))
        self.db.execute('INSERT INTO activity_settings VALUES(?,?)', ('preset:123:毛毯',json.dumps({'size_prices': {'40×50in': {'floor':49,'target_daily':66}}})))

    @contextmanager
    def connect(self):
        yield self.db

    def tearDown(self):
        self.db.close()

    def test_saved_rules(self):
        result=price_window.settings({'mall_id':'123','skc_id':'456'},self.connect)
        self.assertEqual(result['shop_name'],'测试店')
        self.assertEqual(result['preset_name'],'毛毯')
        self.assertEqual(result['size_prices']['40×50in']['floor'],49)

    def test_preset_load_does_not_require_open_skc_drawer(self):
        result=price_window.settings({'mall_id':'123'},self.connect)
        self.assertEqual(result['skc_id'],'')
        self.assertEqual(result['preset_name'],'毛毯')

    def test_only_explicit_activity_decisions_are_returned(self):
        payload={'candidates':[
            {'skcId':'456','skuId':'1','specification':'40*50in','eligible':True},
            {'skcId':'456','skuId':'2','specification':'50*60in','eligible':False},
        ], 'unresolved_candidates':[{'skcId':'456','specification':'60*80in'}]}
        self.db.execute('INSERT INTO activity_evidence_snapshots VALUES(?,?,?,?)',
                        (datetime.now(timezone.utc).isoformat(),'123','campaign-1',json.dumps(payload)))
        result=price_window.settings({'mall_id':'123','skc_id':'456'},self.connect)
        self.assertEqual(result['activity']['state'],'ready')
        self.assertTrue(result['activity']['decisions']['40×50in']['eligible'])
        self.assertFalse(result['activity']['decisions']['50×60in']['eligible'])
        self.assertNotIn('60×80in',result['activity']['decisions'])
        self.assertNotIn('30×40in',result['activity']['decisions'])

    def test_multiple_recent_campaigns_do_not_auto_choose(self):
        for campaign in ('one','two'):
            self.db.execute('INSERT INTO activity_evidence_snapshots VALUES(?,?,?,?)',
                            (datetime.now(timezone.utc).isoformat(),'123',campaign,
                             json.dumps({'candidates':[{'skcId':'456','specification':'40*50in','eligible':True}]})))
        result=price_window.settings({'mall_id':'123','skc_id':'456'},self.connect)
        self.assertEqual(result['activity']['state'],'ambiguous')
        self.assertEqual(result['activity']['decisions'],{})

    def test_stale_activity_evidence_does_not_auto_choose(self):
        self.db.execute('INSERT INTO activity_evidence_snapshots VALUES(?,?,?,?)',
                        ((datetime.now(timezone.utc)-timedelta(days=2)).isoformat(),'123','old',
                         json.dumps({'candidates':[{'skcId':'456','specification':'40*50in','eligible':True}]})))
        result=price_window.settings({'mall_id':'123','skc_id':'456'},self.connect)
        self.assertEqual(result['activity']['state'],'stale')
        self.assertEqual(result['activity']['decisions'],{})

    def test_stale_default_does_not_override_active_preset(self):
        self.db.execute('INSERT INTO activity_settings VALUES(?,?)', ('default:123',json.dumps({'size_prices': {'40×50in': {'floor':999}}})))
        result=price_window.settings({'mall_id':'123','skc_id':'456'},self.connect)
        self.assertEqual(result['size_prices']['40×50in']['floor'],49)

    def test_missing_active_preset_fails_closed(self):
        self.db.execute("DELETE FROM activity_settings WHERE id='active_preset:123'")
        with self.assertRaisesRegex(ValueError,'预设'):
            price_window.settings({'mall_id':'123','skc_id':'456'},self.connect)

    def test_unknown_shop(self):
        with self.assertRaises(ValueError):
            price_window.settings({'mall_id':'999','skc_id':'456'},self.connect)

    def test_no_implicit_defaults(self):
        self.db.execute('DELETE FROM activity_settings')
        with self.assertRaises(ValueError):
            price_window.settings({'mall_id':'123','skc_id':'456'},self.connect)

    def test_invalid_identity(self):
        for mall,skc in [('', '456'),('123','a')]:
            with self.assertRaises(ValueError):
                price_window.settings({'mall_id':mall,'skc_id':skc},self.connect)


if __name__=='__main__':
    unittest.main()
