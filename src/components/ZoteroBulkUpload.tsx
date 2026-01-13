"use client";

import { useState } from "react";
import { Upload, AlertCircle, AlertTriangle, CheckCircle2, XCircle, FileJson, Loader2, Edit2, ChevronDown, ChevronUp, ShieldCheck, ShieldAlert } from "lucide-react";
import { parseZoteroCSV, matchDocumentsToFiles, ParsedZoteroDocument, MatchResult, MatchedItem, TitleVerification } from "@/lib/zotero-parser";

interface ManualAssignment {
  unmatchedPdfFile: File;
  assignedDocument?: ParsedZoteroDocument;
  customMetadata?: {
    "Article Title": string;
    "All authors": string;
    "YEAR accepted": string | number;
    summary?: string;
  };
}

interface UploadState {
  csvFile: File | null;
  pdfFiles: File[];
  parseResult: MatchResult | null;
  manualAssignments: Map<string, ManualAssignment>;
  loading: boolean;
  error: string | null;
  success: string | null;
  expandedSections: Set<string>;
  csvOnlyMode: boolean; // Allow CSV-only import without PDFs
  duplicateConflicts?: Array<{
    index: number;
    title: string;
    existingDocumentId?: string;
    conflictReason: string;
  }>;
  titleVerifications: Map<number, TitleVerification>; // Track title verifications by match index
  verifyingTitles: boolean; // Loading state for title verification
}

export function ZoteroBulkUpload({ onComplete }: { onComplete?: () => void }) {
  const [state, setState] = useState<UploadState>({
    csvFile: null,
    pdfFiles: [],
    parseResult: null,
    manualAssignments: new Map(),
    loading: false,
    error: null,
    success: null,
    expandedSections: new Set(),
    csvOnlyMode: false,
    titleVerifications: new Map(),
    verifyingTitles: false,
  });

  function toggleSection(sectionId: string) {
    setState(prev => {
      const newExpanded = new Set(prev.expandedSections);
      if (newExpanded.has(sectionId)) {
        newExpanded.delete(sectionId);
      } else {
        newExpanded.add(sectionId);
      }
      return { ...prev, expandedSections: newExpanded };
    });
  }

  async function handleCSVChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;

    setState(prev => ({
      ...prev,
      csvFile: file,
      parseResult: null,
      manualAssignments: new Map(),
      error: null,
    }));
  }

  async function handlePDFChange(e: React.ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files || []);
    setState(prev => ({
      ...prev,
      pdfFiles: files,
      parseResult: null,
      manualAssignments: new Map(),
      error: null,
    }));
  }

  async function handleMatch() {
    if (!state.csvFile) {
      setState(prev => ({
        ...prev,
        error: "Please select a CSV file"
      }));
      return;
    }

    if (!state.csvOnlyMode && state.pdfFiles.length === 0) {
      setState(prev => ({
        ...prev,
        error: "Please select PDF files or enable CSV-only mode"
      }));
      return;
    }

    try {
      setState(prev => ({ ...prev, loading: true, error: null }));

      const csvText = await state.csvFile.text();
      const { documents, errors } = parseZoteroCSV(csvText);

      if (errors.length > 0) {
        console.warn("CSV parse warnings:", errors);
      }

      if (documents.length === 0) {
        throw new Error("No valid documents found in CSV");
      }

      let result: MatchResult;

      if (state.csvOnlyMode) {
        // CSV-only mode: treat each CSV entry as metadata-only (no PDF matching)
        result = {
          matched: documents.map(doc => ({
            document: doc,
            pdfFile: undefined, // No associated PDF file
            matchType: "stub" as const,
            confidence: 0 // Metadata-only, not file-based
          })),
          unmatchedDocuments: [],
          unmatchedFiles: []
        };
      } else {
        // Normal mode: match CSV to PDFs
        result = matchDocumentsToFiles(documents, state.pdfFiles);

        // Initialize manual assignments for unmatched PDFs
        const manualAssignments = new Map<string, ManualAssignment>();
        for (const file of result.unmatchedFiles) {
          manualAssignments.set(file.name, {
            unmatchedPdfFile: file,
            customMetadata: {
              "Article Title": file.name.replace(/\.pdf$/i, ""),
              "All authors": "",
              "YEAR accepted": new Date().getFullYear(),
              summary: "",
            }
          });
        }

        setState(prev => ({
          ...prev,
          manualAssignments,
        }));
      }

      setState(prev => ({
        ...prev,
        parseResult: result,
        expandedSections: new Set(["matched", "unmatched-pdfs"]),
        error: errors.length > 0 ? errors.join("; ") : null,
      }));
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : "Failed to parse CSV",
      }));
    } finally {
      setState(prev => ({ ...prev, loading: false }));
    }
  }

  async function verifyTitles() {
    if (!state.parseResult?.matched) return;

    // Only verify matches that have PDF files (not CSV-only mode)
    const matchesWithPdfs = state.parseResult.matched.filter(m => m.pdfFile);
    if (matchesWithPdfs.length === 0) {
      setState(prev => ({ ...prev, error: "No PDFs to verify titles against" }));
      return;
    }

    setState(prev => ({ ...prev, verifyingTitles: true, error: null }));

    const newVerifications = new Map<number, TitleVerification>();
    let warningCount = 0;

    for (let i = 0; i < state.parseResult.matched.length; i++) {
      const match = state.parseResult.matched[i];
      if (!match.pdfFile) continue;

      try {
        const formData = new FormData();
        formData.append('pdfFile', match.pdfFile);
        formData.append('title', match.document.metadata['Article Title'] || '');

        const response = await fetch('/api/admin/verify-title', {
          method: 'POST',
          body: formData,
        });

        if (response.ok) {
          const result = await response.json();
          newVerifications.set(i, {
            verified: result.matches,
            confidence: result.confidence,
            extractedTitle: result.extractedTitle,
            details: result.details,
          });

          if (!result.matches) {
            warningCount++;
          }
        }
      } catch (error) {
        console.error(`Error verifying title for ${match.pdfFile.name}:`, error);
        newVerifications.set(i, {
          verified: false,
          confidence: 0,
          details: 'Verification failed',
        });
      }
    }

    setState(prev => ({
      ...prev,
      titleVerifications: newVerifications,
      verifyingTitles: false,
      error: warningCount > 0
        ? `Title verification found ${warningCount} potential mismatch(es). Review warnings before uploading.`
        : null,
      success: warningCount === 0 ? `All ${newVerifications.size} titles verified successfully!` : null,
    }));
  }

  function updateManualMetadata(pdfName: string, field: string, value: any) {
    setState(prev => {
      const assignment = prev.manualAssignments.get(pdfName);
      if (!assignment || !assignment.customMetadata) return prev;

      const updated = new Map(prev.manualAssignments);
      updated.set(pdfName, {
        ...assignment,
        customMetadata: {
          ...assignment.customMetadata,
          [field]: value
        } as any
      });

      return { ...prev, manualAssignments: updated };
    });
  }

  function assignDocumentToUnmatched(pdfName: string, doc: ParsedZoteroDocument) {
    setState(prev => {
      const updated = new Map(prev.manualAssignments);
      const assignment = updated.get(pdfName);
      if (assignment) {
        updated.set(pdfName, {
          ...assignment,
          assignedDocument: doc,
          customMetadata: undefined
        });
      }
      return { ...prev, manualAssignments: updated };
    });
  }

  async function uploadItems(skipDuplicateCheck: boolean = false) {
    if (!state.parseResult) {
      setState(prev => ({ ...prev, error: "No match result" }));
      return;
    }

    const allItems: Array<{ file?: File; metadata: any }> = [];

    // Add matched items
    for (const item of state.parseResult.matched) {
      if (item.pdfFile) {
        // Normal case: PDF + metadata
        allItems.push({
          file: item.pdfFile,
          metadata: item.document.metadata
        });
      } else if (state.csvOnlyMode) {
        // CSV-only mode: metadata without PDF
        allItems.push({
          metadata: item.document.metadata
        });
      }
    }

    // Add manually assigned items
    for (const [pdfName, assignment] of state.manualAssignments) {
      if (assignment.assignedDocument) {
        allItems.push({
          file: assignment.unmatchedPdfFile,
          metadata: assignment.assignedDocument.metadata
        });
      } else if (assignment.customMetadata) {
        allItems.push({
          file: assignment.unmatchedPdfFile,
          metadata: {
            ...assignment.customMetadata,
            "Attribution URL": "",
            "Sub-tag": ""
          }
        });
      }
    }

    if (allItems.length === 0) {
      setState(prev => ({
        ...prev,
        error: "No items to upload"
      }));
      return;
    }

    try {
      setState(prev => ({ ...prev, loading: true, error: null }));

      // Check for duplicates (unless skipping)
      if (!skipDuplicateCheck) {
        try {
          const checkDupRes = await fetch("/api/admin/documents/check-duplicates", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              documents: allItems.map(item => ({ metadata: item.metadata }))
            })
          });

          if (checkDupRes.ok) {
            const dupResult = await checkDupRes.json();
            if (dupResult.conflicts && dupResult.conflicts.length > 0) {
              setState(prev => ({
                ...prev,
                loading: false,
                duplicateConflicts: dupResult.conflicts,
                error: `⚠️ Found ${dupResult.conflicts.length} potential duplicate(s). Review below before uploading.`
              }));
              return;
            }
          } else {
            console.error("Duplicate check failed:", checkDupRes.status);
          }
        } catch (dupCheckError) {
          console.error("Error checking duplicates:", dupCheckError);
        }
      }

      // No duplicates, proceed with upload
      const formData = new FormData();
      const files: (File | null)[] = [];
      const metadata: any[] = [];

      for (const item of allItems) {
        files.push(item.file || null);
        metadata.push(item.metadata);
      }

      // Only add files that exist (skip null entries for CSV-only mode)
      files.forEach((file, idx) => {
        if (file) formData.append("files", file);
        else formData.append(`file_${idx}`, "null"); // Mark missing files
      });
      formData.append("metadata", JSON.stringify(metadata));

      const response = await fetch("/api/admin/documents", {
        method: "POST",
        body: formData,
      });

      if (!response.ok) {
        const error = await response.json();
        throw new Error(error.error || "Upload failed");
      }

      setState(prev => ({
        ...prev,
        success: `Successfully uploaded ${allItems.length} documents!`,
        csvFile: null,
        pdfFiles: [],
        parseResult: null,
        manualAssignments: new Map(),
        duplicateConflicts: undefined,
      }));

      onComplete?.();
    } catch (error) {
      setState(prev => ({
        ...prev,
        error: error instanceof Error ? error.message : "Upload failed"
      }));
    } finally {
      setState(prev => ({ ...prev, loading: false }));
    }
  }

  async function handleUpload() {
    await uploadItems(false);
  }

  async function handleUploadForced() {
    await uploadItems(true);
  }

  const totalMatched = state.parseResult?.matched.length ?? 0;
  const totalManuallyAssigned = Array.from(state.manualAssignments.values()).filter(
    a => a.assignedDocument || a.customMetadata
  ).length;
  const totalToUpload = totalMatched + totalManuallyAssigned;

  return (
    <div className="space-y-6">
      {/* CSV Upload */}
      <div>
        <label className="block text-sm font-medium mb-2">Zotero Export CSV</label>
        <input
          type="file"
          accept=".csv"
          onChange={handleCSVChange}
          disabled={state.loading}
          className="block w-full text-sm text-gray-500
            file:mr-4 file:py-2 file:px-4
            file:rounded file:border-0
            file:text-sm file:font-semibold
            file:bg-blue-50 file:text-blue-700
            hover:file:bg-blue-100 disabled:opacity-50"
        />
        {state.csvFile && (
          <p className="mt-2 text-sm text-gray-600">
            ✓ Selected: {state.csvFile.name}
          </p>
        )}
      </div>

      {/* CSV-Only Mode Toggle */}
      <div className="flex items-center gap-2 p-3 bg-gray-50 rounded">
        <input
          type="checkbox"
          id="csvOnly"
          checked={state.csvOnlyMode}
          onChange={(e) => setState(prev => ({
            ...prev,
            csvOnlyMode: e.target.checked,
            pdfFiles: e.target.checked ? [] : prev.pdfFiles
          }))}
          disabled={state.loading}
          className="rounded"
        />
        <label htmlFor="csvOnly" className="text-sm text-gray-700">
          CSV-only mode (import metadata without PDF files)
        </label>
      </div>

      {/* PDF Files Upload */}
      {!state.csvOnlyMode && (
        <div>
          <label className="block text-sm font-medium mb-2">PDF Files</label>
          <input
            type="file"
            accept=".pdf"
            multiple
            onChange={handlePDFChange}
            disabled={state.loading}
            className="block w-full text-sm text-gray-500
              file:mr-4 file:py-2 file:px-4
              file:rounded file:border-0
              file:text-sm file:font-semibold
              file:bg-blue-50 file:text-blue-700
              hover:file:bg-blue-100 disabled:opacity-50"
          />
          {state.pdfFiles.length > 0 && (
            <p className="mt-2 text-sm text-gray-600">
              ✓ Selected: {state.pdfFiles.length} file(s)
            </p>
          )}
        </div>
      )}

      {/* Match Button */}
      <button
        onClick={handleMatch}
        disabled={!state.csvFile || (!state.csvOnlyMode && state.pdfFiles.length === 0) || state.loading}
        className="flex items-center gap-2 px-4 py-2 bg-blue-500 text-white rounded hover:bg-blue-600 disabled:bg-gray-400"
      >
        {state.loading ? (
          <>
            <Loader2 size={16} className="animate-spin" />
            Processing...
          </>
        ) : (
          <>
            <FileJson size={16} />
            {state.csvOnlyMode ? "Import CSV Metadata" : "Match CSV to PDFs"}
          </>
        )}
      </button>

      {/* Error Display */}
      {state.error && (
        <div className="flex gap-2 p-3 bg-red-50 border border-red-200 rounded text-sm text-red-700">
          <AlertCircle size={16} className="flex-shrink-0 mt-0.5" />
          <div>{state.error}</div>
        </div>
      )}

      {/* Success Display */}
      {state.success && (
        <div className="flex gap-2 p-3 bg-green-50 border border-green-200 rounded text-sm text-green-700">
          <CheckCircle2 size={16} className="flex-shrink-0 mt-0.5" />
          <div>{state.success}</div>
        </div>
      )}

      {/* Match Results */}
      {state.parseResult && (
        <div className="space-y-4">
          {/* Summary */}
          <div className="p-4 bg-blue-50 border border-blue-200 rounded">
            <div className="grid grid-cols-2 gap-4 text-sm">
              {!state.csvOnlyMode ? (
                <>
                  <div>
                    <span className="text-gray-600">Exact Matches:</span>
                    <span className="ml-2 font-semibold text-blue-700">
                      {state.parseResult.matched.filter(m => m.matchType === "exact").length}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-600">Fuzzy Matches:</span>
                    <span className="ml-2 font-semibold text-blue-700">
                      {state.parseResult.matched.filter(m => m.matchType === "fuzzy").length}
                    </span>
                  </div>
                  <div>
                    <span className="text-gray-600">Manual Assignments:</span>
                    <span className="ml-2 font-semibold text-blue-700">{totalManuallyAssigned}</span>
                  </div>
                </>
              ) : (
                <div>
                  <span className="text-gray-600">Metadata Entries:</span>
                  <span className="ml-2 font-semibold text-blue-700">
                    {state.parseResult.matched.filter(m => m.matchType === "stub").length}
                  </span>
                </div>
              )}
              <div>
                <span className="text-gray-600">Total to Upload:</span>
                <span className="ml-2 font-semibold text-green-700">{totalToUpload}</span>
              </div>
            </div>
          </div>

          {/* Missing Authors Warning */}
          {(() => {
            const docsWithMissingAuthors = state.parseResult.matched.filter(
              m => !m.document.metadata["All authors"] || m.document.metadata["All authors"].trim() === ""
            );
            if (docsWithMissingAuthors.length > 0) {
              return (
                <div className="p-4 bg-yellow-50 border border-yellow-300 rounded">
                  <div className="flex items-start gap-2">
                    <AlertTriangle className="text-yellow-600 flex-shrink-0 mt-0.5" size={18} />
                    <div>
                      <p className="text-sm font-medium text-yellow-800">
                        {docsWithMissingAuthors.length} document(s) have missing author information
                      </p>
                      <p className="text-xs text-yellow-700 mt-1">
                        Consider adding authors before upload for better search and attribution.
                      </p>
                      <ul className="mt-2 text-xs text-yellow-700 max-h-24 overflow-y-auto">
                        {docsWithMissingAuthors.slice(0, 5).map((m, i) => (
                          <li key={i} className="truncate">
                            • {m.document.metadata["Article Title"]?.substring(0, 60) || "Untitled"}...
                          </li>
                        ))}
                        {docsWithMissingAuthors.length > 5 && (
                          <li className="italic">...and {docsWithMissingAuthors.length - 5} more</li>
                        )}
                      </ul>
                    </div>
                  </div>
                </div>
              );
            }
            return null;
          })()}

          {/* Matched Documents */}
          {state.parseResult.matched.length > 0 && (
            <div className="border rounded">
              <button
                onClick={() => toggleSection("matched")}
                className="w-full p-4 flex items-center justify-between bg-green-50 hover:bg-green-100"
              >
                <h3 className="font-medium text-green-700 flex items-center gap-2">
                  <CheckCircle2 size={16} />
                  Matched Documents ({state.parseResult.matched.length})
                </h3>
                {state.expandedSections.has("matched") ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {state.expandedSections.has("matched") && (
                <div className="p-4">
                  {/* Verify Titles Button - only show if not CSV-only mode */}
                  {!state.csvOnlyMode && state.parseResult.matched.some(m => m.pdfFile) && (
                    <button
                      onClick={verifyTitles}
                      disabled={state.verifyingTitles}
                      className="mb-3 flex items-center gap-2 px-3 py-1.5 text-sm bg-blue-100 text-blue-700 rounded hover:bg-blue-200 disabled:bg-gray-200 disabled:text-gray-500"
                    >
                      {state.verifyingTitles ? (
                        <>
                          <Loader2 size={14} className="animate-spin" />
                          Verifying titles...
                        </>
                      ) : (
                        <>
                          <ShieldCheck size={14} />
                          Verify Titles Match PDFs
                        </>
                      )}
                    </button>
                  )}

                  <div className="space-y-2 max-h-64 overflow-y-auto">
                    {state.parseResult.matched.map((match, idx) => {
                      const verification = state.titleVerifications.get(idx);
                      const hasWarning = verification && !verification.verified;

                      return (
                        <div
                          key={idx}
                          className={`p-2 bg-white border rounded text-sm ${
                            hasWarning ? 'border-orange-300 bg-orange-50' : 'border-green-200'
                          }`}
                        >
                          <div className="flex items-start justify-between">
                            <div className="flex-1">
                              <div className={`font-medium ${hasWarning ? 'text-orange-900' : 'text-green-900'}`}>
                                {match.pdfFile?.name || '(No PDF)'}
                              </div>
                              <div className={`text-xs mt-1 ${hasWarning ? 'text-orange-700' : 'text-green-700'}`}>
                                {match.document.metadata["Article Title"]}
                              </div>
                              <div className={`text-xs ${hasWarning ? 'text-orange-600' : 'text-green-600'}`}>
                                {match.matchType === "exact" ? "Exact Match" :
                                 match.matchType === "stub" ? "Metadata Only" :
                                 `Fuzzy (${(match.confidence * 100).toFixed(0)}%)`}
                              </div>

                              {/* Title Verification Status */}
                              {verification && (
                                <div className={`mt-2 p-1.5 rounded text-xs ${
                                  verification.verified
                                    ? 'bg-green-100 text-green-700'
                                    : 'bg-orange-100 text-orange-700'
                                }`}>
                                  <div className="flex items-center gap-1">
                                    {verification.verified ? (
                                      <ShieldCheck size={12} />
                                    ) : (
                                      <ShieldAlert size={12} />
                                    )}
                                    <span className="font-medium">
                                      {verification.verified ? 'Title Verified' : 'Title Mismatch Warning'}
                                    </span>
                                    <span className="ml-1">({(verification.confidence * 100).toFixed(0)}%)</span>
                                  </div>
                                  <div className="mt-0.5 text-xs opacity-80">{verification.details}</div>
                                  {verification.extractedTitle && !verification.verified && (
                                    <div className="mt-1 text-xs">
                                      <span className="font-medium">PDF Title:</span> {verification.extractedTitle}
                                    </div>
                                  )}
                                </div>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Unmatched PDFs - Manual Assignment */}
          {state.parseResult.unmatchedFiles.length > 0 && (
            <div className="border rounded">
              <button
                onClick={() => toggleSection("unmatched-pdfs")}
                className="w-full p-4 flex items-center justify-between bg-yellow-50 hover:bg-yellow-100"
              >
                <h3 className="font-medium text-yellow-700 flex items-center gap-2">
                  <AlertCircle size={16} />
                  Unmatched PDFs ({state.parseResult.unmatchedFiles.length})
                </h3>
                {state.expandedSections.has("unmatched-pdfs") ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {state.expandedSections.has("unmatched-pdfs") && (
                <div className="space-y-4 p-4 max-h-96 overflow-y-auto">
                  {state.parseResult.unmatchedFiles.map((file, idx) => {
                    const assignment = state.manualAssignments.get(file.name);
                    return (
                      <div key={idx} className="p-3 bg-yellow-50 border border-yellow-200 rounded">
                        <div className="text-sm font-medium text-yellow-900 mb-3">{file.name}</div>

                        {assignment?.assignedDocument ? (
                          // Assigned to CSV row
                          <div className="p-2 bg-green-50 border border-green-200 rounded text-sm">
                            <div className="text-green-700 font-medium">✓ Assigned to:</div>
                            <div className="text-green-600">{assignment.assignedDocument.metadata["Article Title"]}</div>
                          </div>
                        ) : (
                          // Custom metadata form
                          <div className="space-y-2">
                            <input
                              type="text"
                              placeholder="Title"
                              value={assignment?.customMetadata?.["Article Title"] || ""}
                              onChange={(e) => updateManualMetadata(file.name, "Article Title", e.target.value)}
                              className="w-full px-2 py-1 text-sm border rounded"
                            />
                            <input
                              type="text"
                              placeholder="Authors"
                              value={assignment?.customMetadata?.["All authors"] || ""}
                              onChange={(e) => updateManualMetadata(file.name, "All authors", e.target.value)}
                              className="w-full px-2 py-1 text-sm border rounded"
                            />
                            <input
                              type="number"
                              placeholder="Year"
                              value={assignment?.customMetadata?.["YEAR accepted"] || ""}
                              onChange={(e) => updateManualMetadata(file.name, "YEAR accepted", parseInt(e.target.value))}
                              className="w-full px-2 py-1 text-sm border rounded"
                            />
                            <textarea
                              placeholder="Summary"
                              value={assignment?.customMetadata?.summary || ""}
                              onChange={(e) => updateManualMetadata(file.name, "summary", e.target.value)}
                              rows={2}
                              className="w-full px-2 py-1 text-sm border rounded"
                            />
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Unmatched CSV Rows */}
          {state.parseResult.unmatchedDocuments.length > 0 && (
            <div className="border rounded">
              <button
                onClick={() => toggleSection("unmatched-csv")}
                className="w-full p-4 flex items-center justify-between bg-gray-50 hover:bg-gray-100"
              >
                <h3 className="font-medium text-gray-700 flex items-center gap-2">
                  <XCircle size={16} />
                  Unmatched CSV Entries ({state.parseResult.unmatchedDocuments.length})
                </h3>
                {state.expandedSections.has("unmatched-csv") ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
              </button>

              {state.expandedSections.has("unmatched-csv") && (
                <div className="space-y-2 p-4 max-h-48 overflow-y-auto">
                  {state.parseResult.unmatchedDocuments.map((doc, idx) => (
                    <div key={idx} className="p-2 bg-white border border-gray-200 rounded text-sm">
                      <div className="font-medium text-gray-700">{doc.filename}</div>
                      <div className="text-gray-600 text-xs">{doc.metadata["Article Title"]}</div>
                      <div className="text-gray-500 text-xs">No matching PDF found</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* Duplicate Conflicts */}
          {state.duplicateConflicts && state.duplicateConflicts.length > 0 && (
            <div className="border border-orange-300 rounded-lg p-4 bg-orange-50">
              <h3 className="font-semibold text-orange-900 mb-3 flex items-center gap-2">
                <AlertCircle size={16} />
                Potential Duplicates Detected
              </h3>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {state.duplicateConflicts.map((conflict, idx) => (
                  <div key={idx} className="text-sm p-2 bg-white rounded border border-orange-200">
                    <div className="font-medium text-orange-900">{conflict.title}</div>
                    <div className="text-orange-700 text-xs mt-1">{conflict.conflictReason}</div>
                    {conflict.existingDocumentId && (
                      <div className="text-orange-600 text-xs mt-1">
                        Exists as: {conflict.existingDocumentId}
                      </div>
                    )}
                  </div>
                ))}
              </div>
              <div className="mt-4 flex gap-2">
                <button
                  onClick={() => setState(prev => ({ ...prev, duplicateConflicts: undefined }))}
                  className="flex-1 px-3 py-2 text-sm border border-orange-300 text-orange-700 rounded hover:bg-orange-100"
                >
                  Cancel
                </button>
                <button
                  onClick={() => {
                    setState(prev => ({ ...prev, duplicateConflicts: undefined }));
                    // Re-trigger upload bypassing duplicate check
                    handleUploadForced();
                  }}
                  className="flex-1 px-3 py-2 text-sm bg-orange-600 text-white rounded hover:bg-orange-700"
                >
                  Upload Anyway
                </button>
              </div>
            </div>
          )}

          {/* Upload Button */}
          {totalToUpload > 0 && !state.duplicateConflicts && (
            <button
              onClick={handleUpload}
              disabled={state.loading}
              className="w-full flex items-center justify-center gap-2 px-6 py-3 bg-green-600 text-white rounded-lg hover:bg-green-700 disabled:bg-gray-400"
            >
              {state.loading ? (
                <>
                  <Loader2 size={18} className="animate-spin" />
                  Uploading...
                </>
              ) : (
                <>
                  <Upload size={18} />
                  Upload {totalToUpload} Item(s)
                </>
              )}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
