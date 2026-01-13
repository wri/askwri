#!/usr/bin/env python3
"""
Debug script to test the context function directly
"""
import requests
import json

def test_context_function():
    print("🔍 Testing context function directly...")

    # Get a result from the service
    response = requests.post("http://127.0.0.1:8002/query", json={
        "query": "electric bus benefits",
        "mode": "answer",
        "max_results": 1
    })

    if response.status_code == 200:
        data = response.json()
        result = data['docs'][0]

        print(f"📄 Content preview (first 200 chars):")
        print(repr(result['content'][:200]))
        print(f"\n📄 Full content length: {len(result['content'])}")

        # Check if the content starts with context markers
        content = result['content']
        if content.startswith('**['):
            print("✅ Context function is working - content starts with markers")

            # Find where the actual passage ends
            end_marker_pos = content.find(']**')
            if end_marker_pos != -1:
                passage = content[3:end_marker_pos]  # Remove **[ and ]**
                print(f"📝 Marked passage: {repr(passage[:100])}")
            else:
                print("❌ Missing closing marker ]**")
                print(f"🔍 Searching for end marker in content...")
                # Look for partial markers
                if '**' in content[10:]:
                    next_marker = content.find('**', 10)
                    print(f"Next ** found at position {next_marker}")
                    print(f"Content around it: {repr(content[next_marker-10:next_marker+20])}")
        else:
            print("❌ Context function not working - no opening markers")

    else:
        print(f"❌ Request failed: {response.status_code}")
        print(response.text)

if __name__ == "__main__":
    test_context_function()