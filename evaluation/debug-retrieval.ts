#!/usr/bin/env node
/**
 * Debug script to see what the hybrid service actually returns
 */

const PYTHON_SERVICE_URL = process.env.LLAMAINDEX_SERVICE_URL || 'http://127.0.0.1:8002';

async function debugQuery() {
  const query = "What have we published on land value capture?";

  console.log('🔍 Sending test query to Python service...');
  console.log(`Query: "${query}"\n`);

  const response = await fetch(`${PYTHON_SERVICE_URL}/query`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      query,
      mode: 'cite',
      max_results: 10,
      similarity_threshold: 0.0,
      include_metadata: true,
      rerank: true
    })
  });

  if (!response.ok) {
    console.error('❌ Error:', response.status, response.statusText);
    return;
  }

  const data = await response.json();

  console.log(`📊 Retrieved ${data.docs.length} documents\n`);
  console.log('=' .repeat(80));

  for (let i = 0; i < Math.min(5, data.docs.length); i++) {
    const doc = data.docs[i];
    console.log(`\n📄 Document ${i + 1}:`);
    console.log(`   doc_id: ${doc.doc_id}`);
    console.log(`   title: ${doc.title}`);
    console.log(`   score: ${doc.score}`);
    console.log(`   metadata.url: ${doc.metadata.url || 'MISSING'}`);
    console.log(`   metadata.file_path: ${doc.metadata.file_path || 'MISSING'}`);
    console.log(`   metadata keys: ${Object.keys(doc.metadata).join(', ')}`);
  }

  console.log('\n' + '='.repeat(80));
  console.log('\n🔍 Checking URL coverage:');

  const docsWithUrls = data.docs.filter((d: any) => d.metadata.url);
  const docsWithoutUrls = data.docs.filter((d: any) => !d.metadata.url);

  console.log(`   Documents with URLs: ${docsWithUrls.length}/${data.docs.length}`);
  console.log(`   Documents without URLs: ${docsWithoutUrls.length}/${data.docs.length}`);

  if (docsWithoutUrls.length > 0) {
    console.log('\n⚠️  Documents missing URLs:');
    docsWithoutUrls.slice(0, 5).forEach((d: any) => {
      console.log(`   - ${d.doc_id}: ${d.title}`);
    });
  }
}

debugQuery().catch(console.error);
