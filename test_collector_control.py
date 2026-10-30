import tempfile
import unittest
from pathlib import Path

import collector_control


class CollectorControlIsolationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.data = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def client(self, client_id, mall_id, browser):
        return {'client_id': client_id, 'mall_id': mall_id, 'browser': browser,
                'store_name': 'shop-' + mall_id[-2:], 'version': '0.15.0', 'claim': True}

    def test_each_browser_only_claims_its_own_store(self):
        collector_control.request(self.data, {'mall_id': '10001'})
        collector_control.request(self.data, {'mall_id': '20002'})
        edge = collector_control.bridge(self.data, self.client('edgeclient01', '20002', 'Edge'))
        chrome = collector_control.bridge(self.data, self.client('chromeclient1', '10001', 'Chrome'))
        self.assertEqual(edge['command']['mall_id'], '20002')
        self.assertEqual(chrome['command']['mall_id'], '10001')
        self.assertNotEqual(edge['command']['claimed_by'], chrome['command']['claimed_by'])

    def test_product_status_requires_new_client_and_correct_store(self):
        old=self.client('chromeclient1', '10001', 'Chrome')
        collector_control.request(self.data, {'mall_id':'10001','task_type':'product_status'})
        self.assertIsNone(collector_control.bridge(self.data, old)['command'])
        new={**old,'version':'0.19.2'}
        self.assertIsNone(collector_control.bridge(self.data,{**new,'mall_id':'20002'})['command'])
        claimed=collector_control.bridge(self.data,new)['command']
        self.assertEqual(claimed['kind'],'product_status')
        self.assertEqual(claimed['mall_id'],'10001')

    def test_explicit_old_product_client_gets_reload_message(self):
        collector_control.bridge(self.data,self.client('chromeclient1','10001','Chrome'))
        with self.assertRaisesRegex(ValueError,'0.19.2'):
            collector_control.request(self.data,{'mall_id':'10001','client_id':'chromeclient1','task_type':'product_status'})

    def test_buggy_product_client_is_rejected_until_fix_is_loaded(self):
        client={**self.client('chromeclient1','10001','Chrome'),'version':'0.19.0'}
        collector_control.bridge(self.data,client)
        with self.assertRaisesRegex(ValueError,'0.19.2'):
            collector_control.request(self.data,{'mall_id':'10001','client_id':'chromeclient1','task_type':'product_status'})

    def test_blocked_queue_and_progress_are_visible_only_for_matching_client(self):
        client={**self.client('chromeclient1','10001','Chrome'),'version':'0.19.2'}
        collector_control.request(self.data,{'mall_id':'10001','client_id':'chromeclient1','task_type':'product_status'})
        collector_control.bridge(self.data,{**client,'claim':False,'blocked_reason':'手动采集仍在运行'})
        self.assertEqual(collector_control.read(self.data)['commands'][0]['message'],'手动采集仍在运行')
        command=collector_control.bridge(self.data,client)['command']
        collector_control.bridge(self.data,{**client,'claim':False,'progress_id':command['id'],'message':'正在采集报名记录'})
        self.assertEqual(collector_control.read(self.data)['commands'][0]['message'],'正在采集报名记录')
        collector_control.bridge(self.data,{**client,'client_id':'otherclient1','claim':False,'progress_id':command['id'],'message':'错误进度'})
        self.assertEqual(collector_control.read(self.data)['commands'][0]['message'],'正在采集报名记录')

    def test_auto_product_error_is_retained_separately_from_generic_flow_message(self):
        client={**self.client('chromeclient1','10001','Chrome'),'version':'0.19.2','claim':False,
                'message':'自动更新已开启，等待下一轮','auto_state':{'enabled':True,'product_error':'页面未就绪','product_retry_at':12345}}
        collector_control.bridge(self.data,client)
        saved=collector_control.read(self.data)['clients']['chromeclient1']
        self.assertEqual(saved['auto_state']['product_error'],'页面未就绪')
        self.assertEqual(saved['auto_state']['product_retry_at'],12345)

    def test_accelerator_requires_02010_and_only_matching_shop_claims(self):
        old={**self.client('chromeclient1','10001','Chrome'),'version':'0.20.8'}
        collector_control.bridge(self.data,old)
        with self.assertRaisesRegex(ValueError,'0.20.10'):
            collector_control.request(self.data,{'mall_id':'10001','client_id':'chromeclient1','task_type':'accelerator_status'})
        collector_control.request(self.data,{'mall_id':'10001','task_type':'accelerator_status'})
        self.assertIsNone(collector_control.bridge(self.data,old)['command'])
        self.assertIsNone(collector_control.bridge(self.data,{**old,'version':'0.20.10','mall_id':'20002'})['command'])
        command=collector_control.bridge(self.data,{**old,'version':'0.20.10'})['command']
        self.assertEqual(command['kind'],'accelerator_status')
        self.assertEqual(command['mall_id'],'10001')

    def test_accelerator_error_is_independent_from_product_success(self):
        client={**self.client('chromeclient1','10001','Chrome'),'version':'0.19.3','claim':False,
                'auto_state':{'product_error':'','accelerator_error':'翻页未变化','accelerator_retry_at':123}}
        collector_control.bridge(self.data,client)
        saved=collector_control.read(self.data)['clients']['chromeclient1']['auto_state']
        self.assertEqual(saved['product_error'],'')
        self.assertEqual(saved['accelerator_error'],'翻页未变化')
        self.assertEqual(saved['accelerator_retry_at'],123)

    def test_pending_signal_is_scoped_and_clears_after_finish(self):
        client={**self.client('chromeclient1','10001','Chrome'),'version':'0.20.10'}
        requested=collector_control.request(self.data,{'mall_id':'10001','client_id':'chromeclient1','task_type':'accelerator_status'})
        self.assertTrue(requested['command_id'])
        self.assertTrue(collector_control.bridge(self.data,{**client,'claim':False})['pending'])
        self.assertFalse(collector_control.bridge(self.data,{**client,'client_id':'otherclient1','claim':False})['pending'])
        self.assertFalse(collector_control.bridge(self.data,{**client,'mall_id':'20002','claim':False})['pending'])
        claimed=collector_control.bridge(self.data,client)
        self.assertEqual(claimed['command']['id'],requested['command_id'])
        self.assertTrue(claimed['pending'])
        finished=collector_control.bridge(self.data,{**client,'claim':False,'finished_id':requested['command_id'],'message':'已完成'})
        self.assertFalse(finished['pending'])

    def test_same_store_cannot_queue_duplicate_but_other_store_can(self):
        collector_control.request(self.data, {'mall_id': '10001'})
        duplicate = collector_control.request(self.data, {'mall_id': '10001'})
        other = collector_control.request(self.data, {'mall_id': '20002'})
        self.assertIn('这家店已有', duplicate['message'])
        self.assertIn('已请求立即采集', other['message'])

    def test_wrong_browser_cannot_finish_another_claim(self):
        collector_control.request(self.data, {'mall_id': '10001'})
        command = collector_control.bridge(self.data, self.client('chromeclient1', '10001', 'Chrome'))['command']
        collector_control.bridge(self.data, {**self.client('edgeclient01', '20002', 'Edge'), 'claim': False,
                                             'finished_id': command['id'], 'message': 'wrong'})
        state = collector_control.read(self.data)
        self.assertEqual(state['commands'][0]['status'], 'running')


if __name__ == '__main__':
    unittest.main()
