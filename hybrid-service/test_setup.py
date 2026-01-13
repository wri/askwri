#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Test script to verify the hybrid service setup
"""

import os
import sys
from pathlib import Path

def test_imports():
    """Test that all required packages can be imported"""
    print("Testing imports...")

    try:
        import llama_index
        print("✅ LlamaIndex imported successfully")
    except ImportError as e:
        print(f"❌ Failed to import LlamaIndex: {e}")
        return False

    try:
        from llama_index.core import VectorStoreIndex
        print("✅ LlamaIndex core imported successfully")
    except ImportError as e:
        print(f"❌ Failed to import LlamaIndex core: {e}")
        return False

    try:
        from llama_index.embeddings.openai import OpenAIEmbedding
        print("✅ OpenAI embeddings imported successfully")
    except ImportError as e:
        print(f"❌ Failed to import OpenAI embeddings: {e}")
        return False

    try:
        from llama_index.retrievers.bm25 import BM25Retriever
        print("✅ BM25 retriever imported successfully")
    except ImportError as e:
        print(f"❌ Failed to import BM25 retriever: {e}")
        return False

    try:
        from llama_index.core.postprocessor import SentenceTransformerRerank
        print("✅ Sentence transformer rerank imported successfully")
    except ImportError as e:
        print(f"❌ Failed to import sentence transformer rerank: {e}")
        return False

    try:
        import fastapi
        print("✅ FastAPI imported successfully")
    except ImportError as e:
        print(f"❌ Failed to import FastAPI: {e}")
        return False

    try:
        import pandas as pd
        print("✅ Pandas imported successfully")
    except ImportError as e:
        print(f"❌ Failed to import pandas: {e}")
        return False

    return True

def test_environment():
    """Test that environment variables are set"""
    print("\nTesting environment...")

    required_vars = ["OPENAI_API_KEY"]
    optional_vars = ["LLAMA_CLOUD_API_KEY"]

    all_good = True

    for var in required_vars:
        if var in os.environ:
            print(f"✅ {var} is set")
        else:
            print(f"❌ {var} is not set (required)")
            all_good = False

    for var in optional_vars:
        if var in os.environ:
            print(f"✅ {var} is set")
        else:
            print(f"⚠️  {var} is not set (optional)")

    return all_good

def test_csv_file():
    """Test that CSV metadata file exists"""
    print("\nTesting CSV file...")

    csv_path = Path("../public/TransportDecarb_llamacloud_metadata_with_summaries.csv")
    if csv_path.exists():
        print(f"✅ CSV file found at {csv_path}")

        # Test reading it
        try:
            import pandas as pd
            df = pd.read_csv(csv_path)
            print(f"✅ CSV file loaded successfully - {len(df)} records")

            # Check required columns
            required_cols = ["metadata", "summary"]
            missing_cols = [col for col in required_cols if col not in df.columns]
            if missing_cols:
                print(f"⚠️  Missing columns: {missing_cols}")
            else:
                print("✅ All required columns present")

            return True
        except Exception as e:
            print(f"❌ Failed to read CSV file: {e}")
            return False
    else:
        print(f"❌ CSV file not found at {csv_path}")
        return False

def test_openai_connection():
    """Test OpenAI API connection"""
    print("\nTesting OpenAI connection...")

    if "OPENAI_API_KEY" not in os.environ:
        print("❌ OPENAI_API_KEY not set, skipping connection test")
        return False

    try:
        from llama_index.embeddings.openai import OpenAIEmbedding

        embed_model = OpenAIEmbedding(
            model="text-embedding-3-small",
            api_key=os.getenv("OPENAI_API_KEY")
        )

        # Test a simple embedding
        test_text = "This is a test sentence for embedding."
        embedding = embed_model.get_text_embedding(test_text)

        if embedding and len(embedding) > 0:
            print(f"✅ OpenAI embedding successful - dimension: {len(embedding)}")
            return True
        else:
            print("❌ OpenAI embedding returned empty result")
            return False

    except Exception as e:
        print(f"❌ OpenAI connection failed: {e}")
        return False

def main():
    """Run all tests"""
    print("🔍 Testing AskWRI Hybrid Service Setup")
    print("=" * 50)

    # Load environment variables from .env file
    env_file = Path(".env")
    if env_file.exists():
        from dotenv import load_dotenv
        load_dotenv()
        print("✅ Loaded environment variables from .env file")
    else:
        print("⚠️  No .env file found")

    tests = [
        ("Package Imports", test_imports),
        ("Environment Variables", test_environment),
        ("CSV Metadata File", test_csv_file),
        ("OpenAI Connection", test_openai_connection),
    ]

    results = []
    for test_name, test_func in tests:
        print(f"\n{'='*20} {test_name} {'='*20}")
        try:
            result = test_func()
            results.append((test_name, result))
        except Exception as e:
            print(f"❌ {test_name} failed with exception: {e}")
            results.append((test_name, False))

    # Summary
    print(f"\n{'='*50}")
    print("📊 TEST SUMMARY")
    print("=" * 50)

    passed = 0
    for test_name, result in results:
        status = "✅ PASS" if result else "❌ FAIL"
        print(f"{status} - {test_name}")
        if result:
            passed += 1

    print(f"\nResult: {passed}/{len(results)} tests passed")

    if passed == len(results):
        print("🎉 All tests passed! The hybrid service setup looks good.")
        return 0
    else:
        print("⚠️  Some tests failed. Please fix the issues before proceeding.")
        return 1

if __name__ == "__main__":
    sys.exit(main())