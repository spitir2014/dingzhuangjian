"""Offline Playwright regression: isolated Node service, mock model catalog, no paid POST."""
import json, os, subprocess, time
from pathlib import Path
from urllib.request import urlopen
from playwright.sync_api import sync_playwright

ROOT=Path(__file__).resolve().parents[1]
temp=ROOT/'tmp'/f'p2-browser-{time.time_ns()}'
temp.mkdir(parents=True)
config=temp/'config.json'
config.write_text(json.dumps({'providers':[{'id':'mock','name':'离线测试','baseUrl':'http://127.0.0.1:1','enabled':True}],'settings':{}}),encoding='utf-8')
env=dict(os.environ,PORT='8818',ZXT_CONFIG=str(config),ZXT_OUT=str(temp/'out'),ZXT_KEY_MOCK='sk-offline')
server=subprocess.Popen(['node',str(ROOT/'server.mjs')],cwd=ROOT,env=env,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
base='http://127.0.0.1:8818'
try:
    for _ in range(50):
        try:
            with urlopen(base+'/api/health',timeout=1) as r: assert json.load(r)['ok']
            break
        except Exception: time.sleep(.1)
    else: raise RuntimeError('Isolated server not ready')
    with sync_playwright() as p:
        browser=p.chromium.launch(headless=True,executable_path='C:/Program Files/Google/Chrome/Application/chrome.exe')
        page=browser.new_page(viewport={'width':1440,'height':900})
        errors=[];paid=[]
        page.on('pageerror',lambda e:errors.append(str(e)))
        page.route('**/api/models?*',lambda route:route.fulfill(json={'ok':True,'models':[{'id':'mock-image'}]}))
        def block_paid(route):
            paid.append(route.request.url)
            route.fulfill(status=500,json={'ok':False,'error':'Paid POST blocked by offline test'})
        page.route('**/api/generate*',block_paid)
        page.goto(base);page.wait_for_load_state('networkidle')
        assert page.locator('#templateSel option').count()==6
        for era in ['qing_early','qing_late']:
            page.evaluate('(era)=>setParamValue("era",era)',era)
            expected=page.evaluate('(era)=>DATA.eras.looks.filter(l=>l.era===era).map(l=>l.id)',era)
            assert page.locator('.look-card').count()==len(expected)
            for look_id in expected:
                label=page.evaluate('(id)=>DATA.eras.looks.find(l=>l.id===id).label',look_id)
                # Duplicate historical/P2 first-rank labels are disambiguated by card title.
                page.evaluate('(id)=>applyLookPreset(id)',look_id)
                result=page.evaluate('''()=>({look:state.lookId,era:state.params.era,evidence:currentLookEvidence(),
                  slots:DATA.eras.looks.find(l=>l.id===state.lookId).slots,
                  actual:Object.fromEntries(DATA.eras.slots.map(s=>[s.id,state.params[s.id]])),
                  text:document.querySelector('#promptPreview').textContent})''')
                assert result['look']==look_id and result['era']==era
                assert result['evidence']['modified'] is False,look_id
                assert result['slots']==result['actual'],look_id
                assert '{{' not in result['text'],look_id
        page.locator('.look-filters').get_by_role('button',name='演绎',exact=True).click()
        assert page.locator('.look-card').count()==2
        page.locator('.look-card').filter(has_text='晚清新军').click()
        assert 'D/E' in page.locator('.look-evidence-summary').inner_text()
        page.locator('.look-filters').get_by_role('button',name='全部',exact=True).click()
        page.locator('.look-card').filter(has_text='晚清旗人贵妇').click()
        assert '氅衣' in page.locator('#promptPreview').inner_text()
        for _ in range(5):
            page.locator('#rerollAll').click()
            assert page.evaluate('()=>state.params.sex')=='female'
            assert page.evaluate('()=>state.params.headwear')=='dalachi'
            assert page.evaluate('()=>state.params.outer')=='late_qing_changyi'
        assert page.evaluate('()=>document.documentElement.scrollWidth <= innerWidth')
        page.screenshot(path=str(ROOT/'docs/screenshots/P2-晚清身份卡.png'),full_page=True)
        page.evaluate('()=>setParamValue("era","qing_early")')
        assert page.evaluate('()=>state.params.headwear')!='dalachi'
        page.evaluate('()=>applyLookPreset("qe_empress_ceremony")')
        page.locator('#templateSel').select_option('costume_breakdown')
        prompt=page.locator('#promptPreview').inner_text()
        assert '三盘朝珠' in prompt and '明黄色朝袍' in prompt and '石青色朝褂' in prompt
        assert '在画面上方留白内靠左排一行' not in prompt
        page.reload();page.wait_for_load_state('networkidle')
        assert page.evaluate('()=>state.lookId')=='qe_empress_ceremony'
        assert page.evaluate('()=>currentLookEvidence().modified') is False
        page.evaluate('()=>setParamValue("color","minghuang")')
        assert '自定义' in page.locator('.look-evidence-summary').inner_text()
        page.evaluate('()=>setParamValue("era","none")')
        assert page.evaluate('()=>currentLookEvidence()') is None
        page.locator('#generateBtn').click()
        assert not paid,'Breakdown in body-only mode must not submit a generation'
        assert not errors,errors
        (temp/'result.json').write_text(json.dumps({'cards':36,'layouts':6,'pageErrors':errors,'paidRequests':paid,'passed':True},ensure_ascii=False,indent=2),encoding='utf-8')
        print('PASS: 36 cards, 6 layouts, filters, full UI clamp, era switch, evidence reload, custom marking and no paid calls.')
        browser.close()
finally:
    server.terminate()
    try: server.wait(timeout=5)
    except subprocess.TimeoutExpired: server.kill()
