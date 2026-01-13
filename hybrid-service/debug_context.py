#!/usr/bin/env python3
"""
Debug script to test surrounding context function without restarting service
"""
import requests
import json

def test_context_issue():
    print("🔍 Testing surrounding context issue...")

    # Get a query result
    response = requests.post("http://127.0.0.1:8002/query", json={
        "query": "electric bus benefits",
        "mode": "answer",
        "max_results": 1
    })

    if response.status_code != 200:
        print(f"❌ Query failed: {response.status_code}")
        return

    data = response.json()
    result = data['docs'][0]

    print(f"📄 Doc ID: {result['doc_id']}")
    print(f"📄 Page: {result['page']}")
    print(f"📄 Content length: {len(result['content'])}")
    print(f"📄 Content preview: {repr(result['content'][:100])}")

    # Check if surrounding context markers are present
    has_markers = '**[' in result['content'] and ']**' in result['content']
    print(f"🔍 Has surrounding context markers: {has_markers}")

    if not has_markers:
        print("❌ Context function not working")

        # Try to simulate the context function locally
        print("\n🧪 Testing context function simulation...")

        # We know from the cache that we have the full document text
        # Let's try to load it from the cache system
        from cache_system import AskWRICache
        cache = AskWRICache()

        # Get doc metadata to find the URL
        doc_id = result['doc_id']
        print(f"🔍 Trying to get cached text for {doc_id}")

        # We need to get the URL somehow... let's try a different approach
        # Check what's in the cache
        cache_stats = cache.get_cache_stats()
        print(f"📊 Cache stats: {cache_stats}")

        if cache_stats['texts'] > 0:
            print("✅ Found cached texts - the issue is likely in the service access")
        else:
            print("❌ No cached texts found")
    else:
        print("✅ Context function working correctly")

if __name__ == "__main__":
    test_context_issue()