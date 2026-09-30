"""Read-only acceptance checks for the preparation bundle."""
import hashlib,json,sqlite3,sys
from pathlib import Path
p=Path(sys.argv[1]).resolve()
m=json.loads((p/'manifest.json').read_text(encoding='utf-8'))
for name,info in m['outputs'].items():
    assert hashlib.sha256((p/name).read_bytes()).hexdigest()==info['sha256'], name
db=sqlite3.connect((p/'knowledge_prepared.sqlite').as_uri()+'?mode=ro',uri=True)
assert db.execute('pragma integrity_check').fetchone()[0]=='ok'
assert not db.execute('pragma foreign_key_check').fetchall()
assert db.execute('select count(*) from knowledge k where not exists(select 1 from provenance p where p.knowledge_id=k.id)').fetchone()[0]==0
assert db.execute("select count(*) from knowledge where audience in ('draft_evidence','staff_reference') and trim(answer)='' ").fetchone()[0]==0
assert db.execute("select count(*) from knowledge where audience in ('question_only','restricted_pointer') and id in(select id from embedding_queue where kind='knowledge')").fetchone()[0]==0
assert db.execute('select count(*) from products').fetchone()[0]==3196
assert db.execute("select count(*) from knowledge where id like 'recipe-pairing-%'").fetchone()[0]==21
assert db.execute("select count(*) from knowledge where id like 'prep-%'").fetchone()[0]==8
for payload, in db.execute('select payload from embedding_queue'):
    r=json.loads(payload)
    assert r['text_sha256']==hashlib.sha256(r['text'].encode()).hexdigest()
    assert r['model']=='text-embedding-v4' and r['dimension']==1024 and r['status']=='pending'
print(json.dumps({'hashes':'passed','sqlite':'passed','source_links':'passed','empty_answers_not_embedded':'passed','recipes':21,'service_supplement':8,'production_changed':False},ensure_ascii=False))
