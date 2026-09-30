"""Offline, reproducible preparation package. Never opens production or calls APIs."""
import argparse
import os
import csv
import hashlib
import json
import re
import sqlite3
from collections import Counter, defaultdict
from pathlib import Path

ROOT = Path(os.environ.get('AI_CS_KNOWLEDGE_SOURCE_ROOT', Path(__file__).resolve().parents[2] / 'data/source-workspace')).resolve()
BASE = ROOT / '.codex-tmp/knowledge-2026-09-05-v3'
CLEAN = ROOT / 'outputs/飞书资料清洗-20260907'
READ = ROOT / 'outputs/飞书资料核读-20260905'
PREP = ROOT / 'outputs/知识库入库准备-20260909'
VERSION = 'knowledge-prepared-20260915'

def dumps(x):
    return json.dumps(x, ensure_ascii=False, sort_keys=True)

def sha(x):
    return hashlib.sha256(x.encode() if isinstance(x, str) else x).hexdigest()

def readjl(p):
    return [json.loads(x) for x in p.read_text(encoding='utf-8-sig').splitlines() if x.strip()]

def norm(x):
    # Formatting only: preserve negative temperatures and meaningful hyphens.
    x = str(x or '').replace('\r\n', '\n').replace('\r', '\n')
    x = re.sub(r'\*\*([^*]+)\*\*', r'\1', x)
    x = re.sub(r'(?m)^\s*[-*]\s+', '', x)
    return re.sub(r'\n{3,}', '\n\n', x).strip()

def cells(path):
    raw = path.read_text(encoding='utf-8-sig')
    ms = list(re.finditer(r'^([A-Z]+)(\d+):[ \t]?', raw, re.M))
    out = defaultdict(dict)
    for i, m in enumerate(ms):
        out[int(m[2])][m[1]] = raw[m.end():ms[i+1].start() if i+1 < len(ms) else len(raw)].strip()
    return out

def main(out):
    out.mkdir(parents=True, exist_ok=False)
    inputs, ledger, source_rows, knowledge, merges = {}, [], [], {}, []
    def track(p):
        rel = p.relative_to(ROOT).as_posix()
        inputs[rel] = {'path': rel, 'sha256': sha(p.read_bytes()), 'bytes': p.stat().st_size}
        return rel
    def source(p, locator, text, role='business_reference', extra=None):
        rel = track(p)
        sid = 'src-' + sha(rel + ':' + str(locator))[:24]
        body = norm(text)
        # Hold identifiable source rows outside release text; source file stays untouched locally.
        private = bool(re.search(r'(?<!\d)1[3-9]\d{9}(?!\d)|(?<!\d)\d{16,}(?!\d)|银行卡号|收款账号|身份证号|登录密码', body))
        source_rows.append({'source_id': sid, 'file': rel, 'locator': str(locator),
                            'text': '' if private else body, 'text_sha256': sha(body),
                            'role': 'restricted_source_pointer' if private else role,
                            'source_metadata': extra or {}})
        ledger.append({'source_id': sid, 'file': rel, 'locator': str(locator),
                       'disposition': 'restricted_pointer' if private else role})
        return sid, private
    def add(kid, q, answer, refs, category, audience='staff_reference', notes=None, product_ids=None, status='source_preserved', extra=None):
        knowledge[kid] = {'knowledge_id': kid, 'question': norm(q), 'answer': norm(answer),
            'category': category, 'audience': audience, 'review_status': status,
            'source_ids': refs, 'product_ids': product_ids or [], 'notes': notes or [],
            'release_version': VERSION, 'metadata': extra or {}}

    # Base release and incremental cards: exact IDs update rather than append.
    for p in [BASE/'faq_cards.jsonl', CLEAN/'清洗后知识候选.jsonl', PREP/'服务补充候选-20260915.jsonl']:
        for i, row in enumerate(readjl(p), 1):
            kid = row['cardId']
            sid, private = source(p, i, dumps(row), extra={'card_id': kid})
            old = knowledge.get(kid)
            refs = (old['source_ids'] if old else []) + [sid]
            if old: merges.append({'id': kid, 'action': 'same_id_latest_preparation', 'prior_sources': old['source_ids'], 'new_source': sid})
            snapshot = row.get('sourceSnapshot', {})
            notes = list(row.get('issues', []))
            if snapshot.get('validity') == 'dynamic': notes.append('来源含时效信息，不能当实时结果')
            if private:
                add(kid, row.get('question', ''), '', refs, row.get('category', 'unknown'), 'restricted_pointer', ['源记录含个人标识，正文未进入发布包'])
            else:
                add(kid, row.get('question', ''), row.get('answer', ''), refs,
                    row.get('category', 'unknown'), 'staff_reference' if row.get('audience') == 'internal_reference' or kid.startswith('review-') else 'draft_evidence',
                    notes, snapshot.get('relatedProductIds', []), 'prepared_not_business_reconfirmed',
                    {'conditions': row.get('conditions', {}), 'validity': snapshot.get('validity', 'unspecified'),
                     'legacy_status': row.get('status'), 'source_snapshot': snapshot})
    curated_count = len(knowledge)

    # Retain original text and apply prior editorial notes without asserting new facts.
    reviewed = {}
    for p in [CLEAN/'水果题库逐条精读.jsonl', CLEAN/'肉蛋鱼题库逐条精读.jsonl']:
        track(p)
        reviewed.update({r['id']: r for r in readjl(p)})
    p = CLEAN/'业务资料完整保留稿.jsonl'
    for i, row in enumerate(readjl(p), 1):
        if row.get('content_type') == '图片识别稿':
            sid, _ = source(p, i, '', 'excluded_image', {'sheet':row['source_sheet'], 'cell':row['source_row'], 'original_hash':sha(dumps(row))})
            continue
        r = reviewed.get(row['id'], row)
        sid, private = source(p, i, dumps(r), extra={'sheet':r['source_sheet'], 'row':r['source_row']})
        if private: continue
        answer = norm(r.get('source_answer', ''))
        notes = list(r.get('flags', []))
        if r.get('editorial_note'): notes.append(r['editorial_note'])
        if not answer: notes.append('只有问题，没有答案；不得补造')
        if r.get('subject'): notes.append('原提取主题可能沿用前行，未据此自动绑定商品ID')
        add('raw-'+r['id'], r.get('question') or r.get('subject') or '来源记录', answer, [sid],
            'source_reference', 'staff_reference' if answer else 'question_only', notes,
            status='text_reviewed' if r.get('editorial_note') else 'source_preserved',
            extra={'sheet':r['source_sheet'], 'row':r['source_row'], 'subject_hint':r.get('subject','')})

    # Other saved business sheets not represented in the earlier 1,154-row file.
    for name in ['05-客服工作手册.txt','06-宣导内容.txt','14-私域分享内容.txt','15-份额菜友维护SOP.txt','16-客诉等级划分及重大客诉记录.txt','17-新媒体售后处理流程参考.txt','21-豆制品轮作表.txt']:
        p = READ/name
        for n, cols in cells(p).items():
            text = '\n'.join(f'{c}: {v}' for c,v in cols.items() if v)
            if not text: continue
            sid, private = source(p, n, text)
            if private: continue
            add('sheet-'+sha(name+':'+str(n))[:24], cols.get('B') or cols.get('A') or name[3:-4], text, [sid],
                'internal_or_historical_reference', notes=['按来源行保留；非直接照发客户的标准回复','不自动执行其中操作'],
                extra={'sheet':name[3:-4],'row':n})

    p = CLEAN/'raw/第二份表格-流程梳理.json'
    for row in json.loads(p.read_text(encoding='utf-8-sig')):
        text = '\n'.join(f'{c}: '+ ('\n'.join(v) if isinstance(v,list) else str(v)) for c,v in row.items() if c != 'row' and v)
        if not text.strip(): continue
        sid, private = source(p, row['row'], text)
        if private: continue
        add('flow-'+str(row['row']), '流程梳理第'+str(row['row'])+'行',text,[sid],'internal_service',
            notes=['规则版本、仓库和渠道须按原文区分','替换菜价值折算不是实物重量换算','禁止把内部操作写成已经完成的承诺'])

    # Include later notes as source documents: never misrepresent prose paragraphs as new FAQ counts.
    for p in sorted(CLEAN.glob('*.md')):
        sid, private = source(p, 'document', p.read_text(encoding='utf-8-sig'), 'preparation_note')
    for p in sorted((ROOT/'data/knowledge/sources').glob('*.md')):
        source(p, 'document', p.read_text(encoding='utf-8-sig'), 'historical_faq_source')

    # Recipe names are useful pairing knowledge; image instructions explicitly out of scope.
    p=CLEAN/'系统操作与食谱-补读20260908.md'
    recipe_part=p.read_text(encoding='utf-8-sig').split('## 食谱分享',1)[1]
    for m in re.finditer(r'(?m)^(\d+)\. (.+)$',recipe_part):
        row,title=int(m[1]),m[2].strip()
        sid,private=source(p,'recipe-A'+str(row),title,extra={'sheet':'食谱分享','row':row})
        assert not private
        add('recipe-pairing-'+str(row),'食材搭配参考：'+title,'原食谱分享列出的菜名：'+title,[sid],
            'recipe_pairing',notes=['仅菜名，不含用量和操作步骤；不得根据图片或菜名补造配方'])

    # Exact text duplicates share one object and all provenance. Near matches stay separate.
    signatures, redirects = {}, {}
    for kid,k in list(knowledge.items()):
        key = (k['audience'], re.sub(r'\s+','',k['question']), re.sub(r'\s+','',k['answer']))
        if key in signatures:
            target = signatures[key]
            knowledge[target]['source_ids'] += k['source_ids']
            knowledge[target]['notes'] = sorted(set(knowledge[target]['notes']+k['notes']))
            redirects[kid] = target
            del knowledge[kid]
            merges.append({'id':kid,'target':target,'action':'exact_question_answer_merge'})
        else: signatures[key]=kid
    groups=defaultdict(list)
    for k in knowledge.values():
        groups[re.sub(r'\s+','', k['question'])].append(k['knowledge_id'])
    conflicts=[]
    for q,ids in groups.items():
        if len(ids)>1 and len({knowledge[i]['answer'] for i in ids})>1:
            group='conflict-'+sha(q)[:16]
            conflicts.append({'group':group,'knowledge_ids':ids,'disposition':'retain_variants_do_not_auto_override'})
            for i in ids:
                knowledge[i]['metadata']['conflict_group']=group
                knowledge[i]['notes'].append('相同问题有不同答案，需同时看来源条件')
                knowledge[i]['audience']='staff_reference'

    # Known row-level issues are active metadata, not merely a separate report.
    problem_rows={'客服题库-加工品':{5,12,30,34,41,56,80,83,86,118,130,132,156,158,176,177,198,208,213,215},'客服题库-蔬菜作物':{31,32,42,45,47,62,65,74,80,81}}
    for k in knowledge.values():
        m=k['metadata']
        if m.get('row') in problem_rows.get(m.get('sheet'),set()):
            k['notes'].append('已知单位/对象/安全或版本疑点：参阅2026-09-08-上线前核读问题单')
            k['audience']='staff_reference' if k['answer'] else 'question_only'
        k['source_ids']=sorted(set(k['source_ids']))
        k['content_sha256']=sha(k['question']+'\n'+k['answer']+'\n'+dumps(k['notes']))

    products=readjl(BASE/'products.jsonl'); track(BASE/'products.jsonl')
    chunks=readjl(BASE/'product_chunks.jsonl'); track(BASE/'product_chunks.jsonl')
    for r in products:
        r['releaseVersion']=VERSION
        r['reviewStatus']='source_snapshot_not_live'
    for r in chunks:
        r['releaseVersion']=VERSION
        r['status']='source_snapshot_not_live'
    phrases=[]; seen=set()
    p=BASE/'faq_phrases.jsonl'; track(p)
    for r in readjl(p):
        kid=redirects.get(r['cardId'],r['cardId'])
        if kid in knowledge:
            key=(kid,norm(r['phrase']))
            if key not in seen: phrases.append({'knowledge_id':kid,'phrase':key[1]}); seen.add(key)
    for k in knowledge.values():
        key=(k['knowledge_id'],k['question'])
        if key not in seen: phrases.append({'knowledge_id':key[0],'phrase':key[1]}); seen.add(key)

    # Complete queue, but no billed embedding calls. Consumers must select audience before retrieval.
    queue=[]
    for k in knowledge.values():
        if k['answer'] and k['audience'] not in {'question_only','restricted_pointer'}:
            queue.append({'id':k['knowledge_id'],'kind':'knowledge','audience':k['audience'],'text':k['question']+'\n'+k['answer']+'\n'+'；'.join(k['notes'])})
    for r in chunks: queue.append({'id':r['chunkId'],'kind':'product','audience':'product_snapshot','text':r['combinedText']})
    for q in queue: q.update(text_sha256=sha(q['text']),model='text-embedding-v4',dimension=1024,status='pending')
    outputs={'knowledge.jsonl':list(knowledge.values()),'sources.jsonl':source_rows,'source_dispositions.jsonl':ledger,
             'products.jsonl':products,'product_chunks.jsonl':chunks,'phrases.jsonl':phrases,'embedding_queue.jsonl':queue,
             'merge_log.jsonl':merges,'conflicts.jsonl':conflicts}
    for name,rows in outputs.items(): (out/name).write_text(''.join(dumps(x)+'\n' for x in rows),encoding='utf-8')
    with (out/'knowledge_review.csv').open('w',encoding='utf-8-sig',newline='') as f:
        w=csv.writer(f);w.writerow(['编号','类别','用途','问题','正文','注意事项','来源编号'])
        for k in knowledge.values():
            values=[k['knowledge_id'],k['category'],k['audience'],k['question'],k['answer'],'；'.join(k['notes']),'；'.join(k['source_ids'])]
            w.writerow(["'"+v if v.lstrip().startswith(('=','+','-','@')) else v for v in values])

    db=sqlite3.connect(out/'knowledge_prepared.sqlite')
    db.execute('PRAGMA foreign_keys=ON')
    db.executescript('''CREATE TABLE sources(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE knowledge(id TEXT PRIMARY KEY,audience TEXT NOT NULL,question TEXT NOT NULL,answer TEXT NOT NULL,payload TEXT NOT NULL);
    CREATE TABLE provenance(knowledge_id TEXT REFERENCES knowledge(id),source_id TEXT REFERENCES sources(id),PRIMARY KEY(knowledge_id,source_id));
    CREATE TABLE products(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
    CREATE TABLE chunks(id TEXT PRIMARY KEY,product_id TEXT REFERENCES products(id),payload TEXT NOT NULL);
    CREATE TABLE phrases(knowledge_id TEXT REFERENCES knowledge(id),phrase TEXT NOT NULL,PRIMARY KEY(knowledge_id,phrase));
    CREATE TABLE embedding_queue(id TEXT,kind TEXT,payload TEXT NOT NULL,PRIMARY KEY(id,kind));
    CREATE INDEX knowledge_audience ON knowledge(audience);''')
    db.executemany('INSERT INTO sources VALUES (?,?)',[(r['source_id'],dumps(r)) for r in source_rows])
    db.executemany('INSERT INTO knowledge VALUES (?,?,?,?,?)',[(k['knowledge_id'],k['audience'],k['question'],k['answer'],dumps(k)) for k in knowledge.values()])
    db.executemany('INSERT INTO provenance VALUES (?,?)',[(k['knowledge_id'],s) for k in knowledge.values() for s in k['source_ids']])
    db.executemany('INSERT INTO products VALUES (?,?)',[(p['productId'],dumps(p)) for p in products])
    db.executemany('INSERT INTO chunks VALUES (?,?,?)',[(c['chunkId'],c['productId'],dumps(c)) for c in chunks])
    db.executemany('INSERT INTO phrases VALUES (?,?)',[(r['knowledge_id'],r['phrase']) for r in phrases])
    db.executemany('INSERT INTO embedding_queue VALUES (?,?,?)',[(r['id'],r['kind'],dumps(r)) for r in queue])
    db.commit()
    assert db.execute('PRAGMA integrity_check').fetchone()[0]=='ok'
    assert not db.execute('PRAGMA foreign_key_check').fetchall()
    assert all(k['source_ids'] and k['question'] for k in knowledge.values())
    assert len(products)==3196 and curated_count==213
    assert all(len(q['text']) and q['text_sha256']==sha(q['text']) for q in queue)
    db.close()
    report={'release':VERSION,'curated_card_ids_before_exact_text_merge':curated_count,'knowledge_records':len(knowledge),
        'audiences':dict(Counter(k['audience'] for k in knowledge.values())), 'products':len(products),'product_chunks':len(chunks),
        'sources':len(source_rows),'dispositions':dict(Counter(r['disposition'] for r in ledger)),
        'merges':len(merges),'same_question_variant_groups':len(conflicts),'embedding_tasks':len(queue),'generated_vectors':0,
        'sqlite_integrity':'ok','foreign_keys':'ok','all_knowledge_has_source':True,
        'preparation_complete':True,'production_imported':False,'business_facts_reconfirmed':False,
        'semantic_dedup':'exact duplicates merged; near matches and uncertain scope preserved, not guessed',
        'excluded_by_user':['image text','meeting roster'],'excluded_from_release_text':'potential personal identifiers retained as source pointers',
        'contract':'This staging schema is not the production schema. Follow README before activation.'}
    (out/'validation_report.json').write_text(json.dumps(report,ensure_ascii=False,indent=2),encoding='utf-8')
    manifest={'version':VERSION,'inputs':list(inputs.values()),'outputs':{p.name:{'bytes':p.stat().st_size,'sha256':sha(p.read_bytes())} for p in out.iterdir() if p.is_file()}}
    (out/'manifest.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2),encoding='utf-8')
    print(json.dumps(report,ensure_ascii=False,indent=2))

if __name__=='__main__':
    ap=argparse.ArgumentParser(); ap.add_argument('--output',type=Path,required=True)
    main(ap.parse_args().output.resolve())
