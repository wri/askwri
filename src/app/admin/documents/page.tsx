"use client";

import { useState, useEffect } from "react";
import { Upload, Plus, RefreshCw, Trash2, Edit2, AlertCircle, CheckCircle2, Clock, Database, Sparkles } from "lucide-react";
import { ZoteroBulkUpload } from "@/components/ZoteroBulkUpload";
import { DocumentEditModal } from "@/components/DocumentEditModal";

interface Document {
  id: string;
  documentId: string; // Original document ID for API calls
  fileName: string;
  title: string;
  authors: string;
  year: number | string;
  url: string;
  summary: string;
  metadata: any;
}

interface Job {
  id: string;
  type: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  progress: number;
  error?: string;
  result?: any;
}

interface IndexingStatus {
  status: string;
  indexing_status: string;
  documents_indexed: number;
  document_texts: number;
  indexes: {
    vector_index: boolean;
    bm25_retriever: boolean;
  };
}

export default function DocumentsAdmin() {
  const [documents, setDocuments] = useState<Document[]>([]);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [loading, setLoading] = useState(false);
  const [uploadMode, setUploadMode] = useState<'single' | 'batch' | 'zotero'>('single');
  const [editingDoc, setEditingDoc] = useState<Document | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [indexingStatus, setIndexingStatus] = useState<IndexingStatus | null>(null);
  const [regeneratingSummaries, setRegeneratingSummaries] = useState<Set<string>>(new Set());
  const [extractingTitles, setExtractingTitles] = useState<Set<number>>(new Set());
  const [extractingAuthors, setExtractingAuthors] = useState<Set<number>>(new Set());

  // Upload state
  const [files, setFiles] = useState<File[]>([]);
  const [metadata, setMetadata] = useState<any[]>([{
    "Article Title": "",
    "All authors": "",
    "YEAR accepted": new Date().getFullYear(),
    "Attribution URL": "",
    "Sub-tag": "",
    "summary": "",
  }]);

  useEffect(() => {
    loadDocuments();
    loadJobs();
    loadIndexingStatus();
  }, []);

  // Poll for job updates
  useEffect(() => {
    const interval = setInterval(() => {
      if (jobs.some(j => j.status === 'queued' || j.status === 'processing')) {
        loadJobs();
      }
    }, 2000);

    return () => clearInterval(interval);
  }, [jobs]);

  async function loadDocuments() {
    try {
      const res = await fetch('/api/admin/documents');
      const data = await res.json();
      setDocuments(data.documents || []);
    } catch (error) {
      console.error('Failed to load documents:', error);
    }
  }

  async function loadJobs() {
    try {
      const res = await fetch('/api/admin/jobs');
      const data = await res.json();
      setJobs(data.jobs || []);
    } catch (error) {
      console.error('Failed to load jobs:', error);
    }
  }

  async function loadIndexingStatus() {
    try {
      const res = await fetch('/api/admin/status');
      const data = await res.json();
      setIndexingStatus(data);
    } catch (error) {
      console.error('Failed to load indexing status:', error);
    }
  }

  async function handleUpload() {
    if (files.length === 0) {
      alert('Please select at least one PDF file');
      return;
    }

    if (files.length !== metadata.length) {
      alert('Number of files must match number of metadata entries');
      return;
    }

    setLoading(true);

    try {
      const formData = new FormData();
      files.forEach(file => formData.append('files', file));
      formData.append('metadata', JSON.stringify(metadata));

      const res = await fetch('/api/admin/documents', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Upload failed');
      }

      const data = await res.json();
      alert(`Successfully queued ${files.length} document(s) for processing`);

      // Reset form
      setFiles([]);
      setMetadata([{
        "Article Title": "",
        "All authors": "",
        "YEAR accepted": new Date().getFullYear(),
        "Attribution URL": "",
        "Sub-tag": "",
        "summary": "",
      }]);

      // Reload jobs
      loadJobs();

    } catch (error: any) {
      alert(`Upload failed: ${error.message}`);
    } finally {
      setLoading(false);
    }
  }

  async function handleDelete(doc: Document) {
    if (!confirm(`Delete ${doc.title}? This cannot be undone.`)) {
      return;
    }

    try {
      const res = await fetch(`/api/admin/documents/${doc.documentId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        throw new Error('Delete failed');
      }

      alert('Document queued for deletion');
      loadJobs();
    } catch (error: any) {
      alert(`Delete failed: ${error.message}`);
    }
  }

  async function handleSaveMetadata(documentId: string, metadata: any) {
    setIsSaving(true);
    try {
      const res = await fetch(`/api/admin/documents/${documentId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ metadata }),
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Update failed');
      }

      alert('Document updated successfully');
      setEditingDoc(null);
      loadDocuments();
      loadJobs();
    } catch (error: any) {
      throw error;
    } finally {
      setIsSaving(false);
    }
  }

  async function handleRegenerateSummary(doc: Document) {
    if (!confirm(`Generate a new summary for "${doc.title}" using AI?\n\nThis will replace the existing summary.`)) {
      return;
    }

    setRegeneratingSummaries(prev => new Set(prev).add(doc.documentId));

    try {
      const res = await fetch(`/api/admin/documents/${doc.documentId}/generate-summary`, {
        method: 'POST',
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.error || 'Summary generation failed');
      }

      const data = await res.json();
      alert(`Summary generated successfully:\n\n${data.summary.substring(0, 200)}...`);

      // Reload documents to show new summary
      loadDocuments();

      // Trigger reindex
      await fetch('/api/admin/jobs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ type: 'reindex', data: { reason: `Summary regenerated for ${doc.documentId}` } }),
      });
      loadJobs();
    } catch (error: any) {
      alert(`Failed to generate summary: ${error.message}`);
    } finally {
      setRegeneratingSummaries(prev => {
        const next = new Set(prev);
        next.delete(doc.documentId);
        return next;
      });
    }
  }

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const newFiles = Array.from(e.target.files || []);
    setFiles(newFiles);

    // Auto-adjust metadata array to match file count
    if (uploadMode === 'batch' && newFiles.length > metadata.length) {
      const additionalMetadata = Array(newFiles.length - metadata.length).fill(null).map(() => ({
        "Article Title": "",
        "All authors": "",
        "YEAR accepted": new Date().getFullYear(),
        "Attribution URL": "",
        "Sub-tag": "",
        "summary": "",
      }));
      setMetadata([...metadata, ...additionalMetadata]);
    }
  }

  function updateMetadata(index: number, field: string, value: any) {
    const newMetadata = [...metadata];
    newMetadata[index][field] = value;
    setMetadata(newMetadata);
  }

  async function handleExtractTitle(index: number) {
    const file = files[index];
    if (!file) {
      alert('No file selected for this document');
      return;
    }

    const currentTitle = metadata[index]["Article Title"] || '';

    setExtractingTitles(prev => new Set(prev).add(index));

    try {
      const formData = new FormData();
      formData.append('file', file);
      formData.append('currentTitle', currentTitle);

      const res = await fetch('/api/admin/extract-title', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.details || error.error || 'Title extraction failed');
      }

      const data = await res.json();
      updateMetadata(index, "Article Title", data.title);
    } catch (error: any) {
      alert(`Failed to extract title: ${error.message}`);
    } finally {
      setExtractingTitles(prev => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  }

  async function handleExtractAuthors(index: number) {
    const file = files[index];
    if (!file) {
      alert('No file selected for this document');
      return;
    }

    setExtractingAuthors(prev => new Set(prev).add(index));

    try {
      const formData = new FormData();
      formData.append('file', file);

      const res = await fetch('/api/admin/extract-authors', {
        method: 'POST',
        body: formData,
      });

      if (!res.ok) {
        const error = await res.json();
        throw new Error(error.details || error.error || 'Author extraction failed');
      }

      const data = await res.json();
      updateMetadata(index, "All authors", data.authors);
    } catch (error: any) {
      alert(`Failed to extract authors: ${error.message}`);
    } finally {
      setExtractingAuthors(prev => {
        const next = new Set(prev);
        next.delete(index);
        return next;
      });
    }
  }

  return (
    <div className="min-h-screen bg-gray-50 p-8">
      <div className="max-w-7xl mx-auto">
        <div className="flex items-center justify-between mb-8">
          <h1 className="text-3xl font-bold">Document Management</h1>
          <button
            onClick={() => { loadDocuments(); loadJobs(); loadIndexingStatus(); }}
            className="flex items-center gap-2 px-4 py-2 bg-gray-200 rounded-lg hover:bg-gray-300"
          >
            <RefreshCw size={18} />
            Refresh
          </button>
        </div>

        {/* Indexing Status Indicator */}
        {indexingStatus && (
          <div className={`mb-6 p-4 rounded-lg border-2 ${indexingStatus.indexing_status === 'healthy' ? 'bg-green-50 border-green-200' : 'bg-yellow-50 border-yellow-200'}`}>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Database size={20} className={indexingStatus.indexing_status === 'healthy' ? 'text-green-600' : 'text-yellow-600'} />
                <div>
                  <h3 className={`font-semibold ${indexingStatus.indexing_status === 'healthy' ? 'text-green-900' : 'text-yellow-900'}`}>
                    Indexing Status: <span className="capitalize">{indexingStatus.indexing_status}</span>
                  </h3>
                  <p className={`text-sm ${indexingStatus.indexing_status === 'healthy' ? 'text-green-700' : 'text-yellow-700'}`}>
                    {indexingStatus.documents_indexed} documents indexed • Vector Index: {indexingStatus.indexes.vector_index ? '✓' : '✗'} • BM25: {indexingStatus.indexes.bm25_retriever ? '✓' : '✗'}
                  </p>
                </div>
              </div>
              {indexingStatus.indexing_status === 'healthy' && (
                <CheckCircle2 size={24} className="text-green-600" />
              )}
            </div>
          </div>
        )}

        {/* Upload Section */}
        <div className="bg-white rounded-lg shadow p-6 mb-8">
          <h2 className="text-xl font-semibold mb-4">Upload New Documents</h2>

          {/* Mode Toggle */}
          <div className="flex gap-4 mb-4 flex-wrap">
            <button
              onClick={() => setUploadMode('single')}
              className={`px-4 py-2 rounded ${uploadMode === 'single' ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}
            >
              Single Document
            </button>
            <button
              onClick={() => setUploadMode('batch')}
              className={`px-4 py-2 rounded ${uploadMode === 'batch' ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}
            >
              Batch Upload
            </button>
            <button
              onClick={() => setUploadMode('zotero')}
              className={`px-4 py-2 rounded ${uploadMode === 'zotero' ? 'bg-blue-500 text-white' : 'bg-gray-200'}`}
            >
              Zotero Import
            </button>
          </div>

          {/* Zotero Mode */}
          {uploadMode === 'zotero' && (
            <ZoteroBulkUpload onComplete={() => {
              loadDocuments();
              loadJobs();
            }} />
          )}

          {/* Single/Batch Mode */}
          {uploadMode !== 'zotero' && (
            <>
              {/* File Input */}
              <div className="mb-4">
                <label className="block text-sm font-medium mb-2">PDF Files</label>
                <input
                  type="file"
                  accept=".pdf"
                  multiple={uploadMode === 'batch'}
                  onChange={handleFileChange}
                  className="block w-full text-sm text-gray-500
                    file:mr-4 file:py-2 file:px-4
                    file:rounded file:border-0
                    file:text-sm file:font-semibold
                    file:bg-blue-50 file:text-blue-700
                    hover:file:bg-blue-100"
                />
                {files.length > 0 && (
                  <p className="mt-2 text-sm text-gray-600">
                    Selected: {files.map(f => f.name).join(', ')}
                  </p>
                )}
              </div>

              {/* Metadata Forms */}
              <div className="space-y-6">
            {metadata.map((meta, index) => (
              <div key={index} className="border rounded-lg p-4">
                <h3 className="font-medium mb-3">
                  Document {index + 1} Metadata {files[index] && `(${files[index].name})`}
                </h3>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium mb-1">Title *</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={meta["Article Title"]}
                        onChange={(e) => updateMetadata(index, "Article Title", e.target.value)}
                        className="flex-1 px-3 py-2 border rounded"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => handleExtractTitle(index)}
                        disabled={!files[index] || extractingTitles.has(index)}
                        className={`px-3 py-2 rounded transition-colors flex items-center gap-1 ${
                          extractingTitles.has(index)
                            ? 'bg-gray-200 text-gray-500 cursor-wait'
                            : files[index]
                            ? 'bg-purple-50 text-purple-600 hover:bg-purple-100'
                            : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        }`}
                        title={files[index] ? "Extract title from PDF using AI" : "Select a PDF file first"}
                      >
                        {extractingTitles.has(index) ? (
                          <RefreshCw size={16} className="animate-spin" />
                        ) : (
                          <Sparkles size={16} />
                        )}
                        <span className="text-xs whitespace-nowrap">Extract</span>
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Authors *</label>
                    <div className="flex gap-2">
                      <input
                        type="text"
                        value={meta["All authors"]}
                        onChange={(e) => updateMetadata(index, "All authors", e.target.value)}
                        className="flex-1 px-3 py-2 border rounded"
                        placeholder="Last, First; Last, First"
                        required
                      />
                      <button
                        type="button"
                        onClick={() => handleExtractAuthors(index)}
                        disabled={!files[index] || extractingAuthors.has(index)}
                        className={`px-3 py-2 rounded transition-colors flex items-center gap-1 ${
                          extractingAuthors.has(index)
                            ? 'bg-gray-200 text-gray-500 cursor-wait'
                            : files[index]
                            ? 'bg-purple-50 text-purple-600 hover:bg-purple-100'
                            : 'bg-gray-100 text-gray-400 cursor-not-allowed'
                        }`}
                        title={files[index] ? "Extract authors from PDF using AI" : "Select a PDF file first"}
                      >
                        {extractingAuthors.has(index) ? (
                          <RefreshCw size={16} className="animate-spin" />
                        ) : (
                          <Sparkles size={16} />
                        )}
                        <span className="text-xs whitespace-nowrap">Extract</span>
                      </button>
                    </div>
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Year *</label>
                    <input
                      type="number"
                      value={meta["YEAR accepted"]}
                      onChange={(e) => updateMetadata(index, "YEAR accepted", parseInt(e.target.value))}
                      className="w-full px-3 py-2 border rounded"
                      required
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Attribution URL</label>
                    <input
                      type="url"
                      value={meta["Attribution URL"]}
                      onChange={(e) => updateMetadata(index, "Attribution URL", e.target.value)}
                      className="w-full px-3 py-2 border rounded"
                      placeholder="Optional URL to original source"
                    />
                  </div>
                  <div>
                    <label className="block text-sm font-medium mb-1">Sub-tag</label>
                    <input
                      type="text"
                      value={meta["Sub-tag"]}
                      onChange={(e) => updateMetadata(index, "Sub-tag", e.target.value)}
                      className="w-full px-3 py-2 border rounded"
                    />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-sm font-medium mb-1">Summary</label>
                    <textarea
                      value={meta["summary"]}
                      onChange={(e) => updateMetadata(index, "summary", e.target.value)}
                      className="w-full px-3 py-2 border rounded"
                      rows={3}
                      placeholder="Brief summary of the document"
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>

              <button
                onClick={handleUpload}
                disabled={loading || files.length === 0}
                className="mt-4 flex items-center gap-2 px-6 py-3 bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:bg-gray-400"
              >
                <Upload size={18} />
                {loading ? 'Uploading...' : 'Upload & Process'}
              </button>
            </>
          )}
        </div>

        {/* Jobs Status */}
        {jobs.length > 0 && (
          <div className="bg-white rounded-lg shadow p-6 mb-8">
            <h2 className="text-xl font-semibold mb-4">Processing Jobs</h2>
            <div className="space-y-3">
              {jobs.slice(0, 10).map(job => (
                <div key={job.id} className="flex items-center gap-4 p-3 border rounded">
                  {job.status === 'completed' && <CheckCircle2 className="text-green-500" size={20} />}
                  {job.status === 'failed' && <AlertCircle className="text-red-500" size={20} />}
                  {(job.status === 'queued' || job.status === 'processing') && <Clock className="text-blue-500" size={20} />}

                  <div className="flex-1">
                    <div className="font-medium">{job.type.replace('_', ' ').toUpperCase()}</div>
                    <div className="text-sm text-gray-600">{job.status}</div>
                    {job.error && <div className="text-sm text-red-600">{job.error}</div>}
                  </div>

                  <div className="w-32">
                    <div className="text-sm text-gray-600 mb-1">{job.progress}%</div>
                    <div className="w-full bg-gray-200 rounded-full h-2">
                      <div
                        className="bg-blue-600 h-2 rounded-full transition-all"
                        style={{ width: `${job.progress}%` }}
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Documents List */}
        <div className="bg-white rounded-lg shadow">
          <div className="p-6 border-b">
            <h2 className="text-xl font-semibold">Existing Documents ({documents.length})</h2>
          </div>
          <div className="divide-y max-h-[600px] overflow-y-auto">
            {documents.map(doc => (
              <div key={doc.id} className="p-4 hover:bg-gray-50">
                <div className="flex items-start justify-between">
                  <div className="flex-1">
                    <h3 className="font-medium flex items-center gap-2">
                      {doc.title}
                      {!doc.summary && (
                        <span className="inline-flex items-center px-2 py-0.5 text-xs font-medium bg-orange-100 text-orange-800 rounded">
                          No summary
                        </span>
                      )}
                    </h3>
                    <p className="text-sm text-gray-600 mt-1">{doc.authors}</p>
                    <p className="text-sm text-gray-500 mt-1">
                      {doc.year} • {doc.documentId}
                    </p>
                    {doc.summary ? (
                      <p className="text-sm text-gray-700 mt-2 line-clamp-2">{doc.summary}</p>
                    ) : (
                      <p className="text-sm text-orange-600 mt-2 italic">
                        Click the ✨ icon to generate a summary using AI
                      </p>
                    )}
                  </div>
                  <div className="flex gap-2 ml-4">
                    <button
                      onClick={() => setEditingDoc(doc)}
                      className="p-2 text-blue-600 hover:bg-blue-50 rounded transition-colors"
                      title="Edit metadata"
                      disabled={isSaving}
                    >
                      <Edit2 size={18} />
                    </button>
                    <button
                      onClick={() => handleRegenerateSummary(doc)}
                      className={`p-2 rounded transition-colors ${
                        regeneratingSummaries.has(doc.documentId)
                          ? 'text-gray-400 cursor-wait'
                          : doc.summary
                          ? 'text-purple-600 hover:bg-purple-50'
                          : 'text-orange-600 hover:bg-orange-50'
                      }`}
                      title={doc.summary ? "Regenerate summary with AI" : "Generate missing summary with AI"}
                      disabled={regeneratingSummaries.has(doc.documentId) || isSaving}
                    >
                      {regeneratingSummaries.has(doc.documentId) ? (
                        <RefreshCw size={18} className="animate-spin" />
                      ) : (
                        <Sparkles size={18} />
                      )}
                    </button>
                    <button
                      onClick={() => handleDelete(doc)}
                      className="p-2 text-red-600 hover:bg-red-50 rounded transition-colors"
                      title="Delete"
                      disabled={isSaving}
                    >
                      <Trash2 size={18} />
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Edit Modal */}
        {editingDoc && (
          <DocumentEditModal
            document={editingDoc}
            isOpen={Boolean(editingDoc)}
            onClose={() => setEditingDoc(null)}
            onSave={(metadata) => handleSaveMetadata(editingDoc.documentId, metadata)}
            isLoading={isSaving}
          />
        )}
      </div>
    </div>
  );
}