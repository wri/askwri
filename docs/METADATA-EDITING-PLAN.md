# PDF Metadata Editing After Upload - Implementation Plan

## Overview

Enable users to edit document metadata (title, authors, year, summary, tags, URLs) after PDF upload through the admin interface. The API infrastructure (`PATCH /api/admin/documents/:id`) already exists and is functional—this plan focuses on the UI layer.

**Current State:**
- ✅ API endpoint exists: `PATCH /api/admin/documents/:id` with metadata update support
- ✅ CSV backend supports updates: `addDocumentToCSV()` replaces existing entries
- ✅ Reindex job queuing: Changes trigger automatic reindex
- ❌ UI for editing: Currently only delete button exists; no edit interface

---

## Design Options

### Option A: Inline Editing (Recommended)
Edit fields directly in the document list with minimal UI footprint.

**Pros:**
- Fast workflows (edit without modal navigation)
- See all documents and changes simultaneously
- Lower cognitive load
- Real-time validation visible

**Cons:**
- Dense UI if many documents displayed
- Limited space for rich fields (especially summary)
- No confirmation before save (risk of accidental changes)

**Implementation:**
- Toggle edit mode per row or globally
- Inline inputs replace display text
- Save/Cancel buttons per row
- Auto-save with debounce optional

---

### Option B: Modal/Drawer Editor (Safe Default)
Edit one document at a time in a dedicated modal/drawer.

**Pros:**
- Clear scope (edit one at a time)
- Ample space for all fields including summary
- Easy confirmation flow
- Reduced accidental changes

**Cons:**
- Context switching required
- Slower for bulk edits
- Additional modal navigation

**Implementation:**
- Edit button opens modal
- Form identical to upload form
- Cancel/Save buttons with confirmation
- Validation errors shown clearly

---

### Option C: Hybrid Approach (Flexibility)
Quick inline editing for simple fields (title, authors, year), drawer for complex fields (summary, custom metadata).

**Pros:**
- Fast for common edits
- Safe for complex edits
- Flexible workflow
- Best of both worlds

**Cons:**
- More complex to implement
- Inconsistent UX (some fields inline, some modal)

---

## Recommended Approach: Option B (Modal/Drawer) + Simple Inline

**Rationale:**
- Start with modal (safe, clear, well-understood UX)
- Add inline quick-edit as future enhancement if needed
- Drawer allows full metadata form without cramping existing layout

**Phases:**
1. **Phase 1 (MVP):** Modal editor for all fields
2. **Phase 2 (Nice-to-have):** Bulk edit via CSV upload
3. **Phase 3 (Optional):** Quick inline edit for selected fields

---

## Phase 1: Modal Editor (MVP)

### UI Components to Add

#### 1. Edit Button in Document List
**Location:** `src/app/admin/documents/page.tsx` line 386-394

Add edit button alongside delete button:
```jsx
<button
  onClick={() => openEditModal(doc)}
  className="p-2 text-blue-600 hover:bg-blue-50 rounded"
  title="Edit"
>
  <Edit2 size={18} />
</button>
```

#### 2. Edit Modal Component
**New file:** `src/components/DocumentEditModal.tsx` (150-200 lines)

```tsx
interface DocumentEditModalProps {
  document: Document;
  isOpen: boolean;
  onClose: () => void;
  onSave: (metadata: any) => Promise<void>;
  isLoading: boolean;
}

export function DocumentEditModal({
  document,
  isOpen,
  onClose,
  onSave,
  isLoading,
}: DocumentEditModalProps) {
  // Form state and submission logic
  // Reuse metadata form from upload UI
}
```

### Updated Component State
**Location:** `src/app/admin/documents/page.tsx` lines 27-31

Add to component state:
```typescript
const [editingDoc, setEditingDoc] = useState<Document | null>(null);
const [isSaving, setIsSaving] = useState(false);
```

### Update Metadata Handler
**Location:** `src/app/admin/documents/page.tsx` (after line 151)

Add new function:
```typescript
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
    loadDocuments(); // Reload to show changes
    loadJobs(); // Check job status
  } catch (error: any) {
    alert(`Update failed: ${error.message}`);
  } finally {
    setIsSaving(false);
  }
}
```

### Modal Integration
**Location:** `src/app/admin/documents/page.tsx` (before closing `</div>` around line 401)

Add modal at bottom of component:
```jsx
{editingDoc && (
  <DocumentEditModal
    document={editingDoc}
    isOpen={Boolean(editingDoc)}
    onClose={() => setEditingDoc(null)}
    onSave={(metadata) => handleSaveMetadata(editingDoc.id, metadata)}
    isLoading={isSaving}
  />
)}
```

### Form Field Mapping
Map document fields to editable metadata:

| UI Label | Document Field | Metadata Key | Type | Editable |
|----------|----------------|--------------|------|----------|
| Title | title | Article Title | text | ✅ |
| Authors | authors | All authors | text | ✅ |
| Year | year | YEAR accepted | number | ✅ |
| Attribution URL | attributionUrl | Attribution URL | url | ✅ |
| Sub-tag | - | Sub-tag | text | ✅ |
| Summary | summary | summary | textarea | ✅ |
| DOI | - | DOI | text | ❌ (enriched) |
| File Name | fileName | - | text | ❌ (read-only) |

### Validation Rules

| Field | Rules |
|-------|-------|
| Title | Required, 3-200 chars |
| Authors | Optional, semicolon-separated format |
| Year | Required, 4-digit number (1800-2100) |
| Attribution URL | Optional, valid HTTP(S) URL |
| Sub-tag | Optional, 0-100 chars |
| Summary | Optional, 0-2000 chars |

### Error Handling

1. **Validation Errors:** Show inline under each field
2. **API Errors:** Show toast/alert with error message
3. **Network Errors:** Retry button or manual retry prompt
4. **Duplicate Detection:** Check for title+year+author conflicts before save (optional)

---

## Phase 2: Bulk Metadata Editing (Future)

**Option A: CSV Upload**
- Upload CSV with document IDs and new metadata
- Validate matches before applying
- Preview changes before confirmation

**Option B: Batch Form**
- Select multiple documents
- Edit common fields (year, tag) for all at once
- Apply only to selected fields

**Decision:** Defer to user feedback after Phase 1

---

## Phase 3: Quick Inline Edit (Optional)

**Single-click edit** for frequently changed fields:
- Title: Becomes editable input on hover
- Year: Inline number input
- Summary: Expand textarea on focus

**Trade-offs:**
- Faster for power users
- Riskier for accidental changes
- Requires extra styling complexity

**Decision:** Implement only if bulk of edit requests are for simple fields

---

## Technical Details

### State Management
```typescript
// In DocumentsAdmin component
const [editingDoc, setEditingDoc] = useState<Document | null>(null);
const [isSaving, setIsSaving] = useState(false);
const [formErrors, setFormErrors] = useState<Record<string, string>>({});
```

### API Contract
Already implemented, no changes needed:
```typescript
// PATCH /api/admin/documents/:id
Request: { metadata: { "Article Title": "...", ... } }
Response: { success: true, documentId: "...", jobId: "..." }
Error: { error: "message", details?: "..." }
```

### CSV Update Flow
1. UI collects new metadata
2. POST/PATCH to `/api/admin/documents/:id`
3. Backend calls `addDocumentToCSV()` (replaces entry)
4. Backend queues `reindex` job
5. UI shows success and reloads documents
6. Reindex job regenerates search indexes

### Data Consistency

**Assumption:** Editing UI will not be used by multiple users simultaneously
- No conflict resolution needed (last write wins)
- No locking mechanism required

**If multi-user needed (future):**
- Add `updated_at` timestamp to CSV
- Detect conflicts via timestamp comparison
- Show warning if document changed since view

---

## Implementation Checklist

### Phase 1: MVP Modal Editor

- [ ] Create `DocumentEditModal.tsx` component
  - [ ] Form fields for all editable metadata
  - [ ] Validation logic
  - [ ] Loading/error states
  - [ ] Cancel/Save buttons
  - [ ] Close on save/cancel

- [ ] Update `page.tsx` admin documents
  - [ ] Add edit state (editingDoc, isSaving)
  - [ ] Add Edit button to document list
  - [ ] Add modal render
  - [ ] Add `handleSaveMetadata()` function
  - [ ] Add success/error feedback

- [ ] Styling
  - [ ] Modal styling (match existing design)
  - [ ] Form inputs (reuse from upload UI)
  - [ ] Buttons and loading states
  - [ ] Error message styling

- [ ] Testing
  - [ ] Can open/close modal
  - [ ] Can edit each field
  - [ ] Validation shows errors
  - [ ] Save updates via API
  - [ ] Error handling works
  - [ ] Reloads after save

### Phase 2: Bulk Edit (Deferred)

- [ ] Design bulk edit UX
- [ ] Implement multi-select in document list
- [ ] Create batch form component
- [ ] Handle partial field updates
- [ ] Validate batch before apply

### Phase 3: Inline Edit (Deferred)

- [ ] Design inline edit UX
- [ ] Implement hover/focus triggers
- [ ] Handle save via API
- [ ] Manage loading states
- [ ] Fallback to modal if needed

---

## Risk Assessment

### Low Risk
- ✅ API already built and tested (PATCH endpoint)
- ✅ CSV backend supports updates (addDocumentToCSV)
- ✅ Form validation logic can be reused from upload UI
- ✅ No new API infrastructure needed

### Medium Risk
- ⚠️ UI state management (editingDoc, modal open/close)
- ⚠️ Form field synchronization with document fields
- ⚠️ Validation error display

### High Risk
- 🔴 Multi-user edit conflicts (not addressed, assume single-user)
- 🔴 Audit trail for edits (not currently logged)
- 🔴 Rollback capability (not supported in current CSV architecture)

---

## Estimated Effort

| Phase | Task | Time |
|-------|------|------|
| 1 | Create DocumentEditModal component | 2 hours |
| 1 | Update admin page component | 1.5 hours |
| 1 | Testing & debugging | 1.5 hours |
| **Phase 1 Total** | | **5 hours** |
| 2 | Design bulk edit UX | 1 hour |
| 2 | Implement batch form | 3 hours |
| **Phase 2 Total** | | **4 hours** |
| 3 | Design inline edit UX | 1 hour |
| 3 | Implement inline editing | 3 hours |
| **Phase 3 Total** | | **4 hours** |

---

## Success Criteria

### Phase 1 (MVP)
- [ ] Users can click "Edit" on any document
- [ ] Modal opens with current metadata pre-populated
- [ ] All fields (title, authors, year, URL, tag, summary) are editable
- [ ] Form validates all inputs before submission
- [ ] Save button updates document via API
- [ ] Success message shown after save
- [ ] Document list reloads to show changes
- [ ] Errors handled gracefully with user-friendly messages
- [ ] Cancel button closes modal without changes

### Phase 2 (Bulk Edit)
- [ ] Users can select multiple documents
- [ ] Can edit common fields for all selected
- [ ] Preview changes before applying
- [ ] Batch operation queued and tracked

### Phase 3 (Inline Edit)
- [ ] Quick fields editable inline (title, year)
- [ ] Auto-save or explicit save
- [ ] Fallback to modal for complex edits

---

## Future Considerations

1. **Audit Logging:** Log all metadata changes with timestamp, user, old/new values
2. **Version History:** Keep CSV backup with date stamps for rollback
3. **Conflict Resolution:** Handle simultaneous edits with timestamps
4. **Permissions:** Restrict editing to admin role
5. **Metadata Templates:** Save/apply common metadata sets
6. **Enrichment:** Auto-fill metadata from DOI or ISBN lookups

---

## Related Issues

- Integration with authentication system (currently no auth on `/admin` routes)
- Performance if document list grows large (>1000 documents)
- CSV file format limitations (no built-in concurrency, single-file bottleneck)
- Reindex job performance with large corpus (async, may not complete before next edit)

---

## Appendix: Component Templates

### DocumentEditModal.tsx Template

```typescript
"use client";

import { useState, useEffect } from "react";
import { X, AlertCircle } from "lucide-react";

interface Document {
  id: string;
  fileName: string;
  title: string;
  authors: string;
  year: number | string;
  url: string;
  summary: string;
  metadata: any;
}

interface DocumentEditModalProps {
  document: Document;
  isOpen: boolean;
  onClose: () => void;
  onSave: (metadata: any) => Promise<void>;
  isLoading: boolean;
}

export function DocumentEditModal({
  document,
  isOpen,
  onClose,
  onSave,
  isLoading,
}: DocumentEditModalProps) {
  const [formData, setFormData] = useState(document.metadata);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      setFormData(document.metadata);
      setErrors({});
      setSaveError(null);
    }
  }, [isOpen, document]);

  function validate(): boolean {
    const newErrors: Record<string, string> = {};

    if (!formData["Article Title"]?.trim()) {
      newErrors["Article Title"] = "Title is required";
    } else if (formData["Article Title"].length > 200) {
      newErrors["Article Title"] = "Title must be under 200 characters";
    }

    const year = parseInt(formData["YEAR accepted"]);
    if (!year || year < 1800 || year > 2100) {
      newErrors["YEAR accepted"] = "Enter a valid year between 1800-2100";
    }

    setErrors(newErrors);
    return Object.keys(newErrors).length === 0;
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaveError(null);

    if (!validate()) return;

    try {
      await onSave(formData);
    } catch (error: any) {
      setSaveError(error.message || "Failed to save changes");
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-white rounded-lg shadow-lg max-w-2xl w-full max-h-[90vh] overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 flex items-center justify-between p-6 border-b bg-white">
          <h2 className="text-xl font-semibold">Edit Document Metadata</h2>
          <button onClick={onClose} className="text-gray-500 hover:text-gray-700">
            <X size={24} />
          </button>
        </div>

        {/* Form */}
        <form onSubmit={handleSubmit} className="p-6">
          {saveError && (
            <div className="mb-4 p-3 bg-red-50 border border-red-200 rounded flex gap-2">
              <AlertCircle className="text-red-600" size={20} />
              <p className="text-red-700">{saveError}</p>
            </div>
          )}

          <div className="grid grid-cols-2 gap-4 mb-6">
            {/* Title */}
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1">Title *</label>
              <input
                type="text"
                value={formData["Article Title"] || ""}
                onChange={(e) => setFormData({ ...formData, "Article Title": e.target.value })}
                className={`w-full px-3 py-2 border rounded ${
                  errors["Article Title"] ? "border-red-500" : ""
                }`}
              />
              {errors["Article Title"] && (
                <p className="text-sm text-red-600 mt-1">{errors["Article Title"]}</p>
              )}
            </div>

            {/* Authors */}
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1">Authors</label>
              <input
                type="text"
                value={formData["All authors"] || ""}
                onChange={(e) => setFormData({ ...formData, "All authors": e.target.value })}
                className="w-full px-3 py-2 border rounded"
                placeholder="Last, First; Last, First"
              />
            </div>

            {/* Year */}
            <div>
              <label className="block text-sm font-medium mb-1">Year *</label>
              <input
                type="number"
                value={formData["YEAR accepted"] || ""}
                onChange={(e) => setFormData({ ...formData, "YEAR accepted": parseInt(e.target.value) })}
                className={`w-full px-3 py-2 border rounded ${
                  errors["YEAR accepted"] ? "border-red-500" : ""
                }`}
              />
              {errors["YEAR accepted"] && (
                <p className="text-sm text-red-600 mt-1">{errors["YEAR accepted"]}</p>
              )}
            </div>

            {/* Attribution URL */}
            <div>
              <label className="block text-sm font-medium mb-1">Attribution URL</label>
              <input
                type="url"
                value={formData["Attribution URL"] || ""}
                onChange={(e) => setFormData({ ...formData, "Attribution URL": e.target.value })}
                className="w-full px-3 py-2 border rounded"
                placeholder="Optional URL"
              />
            </div>

            {/* Sub-tag */}
            <div>
              <label className="block text-sm font-medium mb-1">Sub-tag</label>
              <input
                type="text"
                value={formData["Sub-tag"] || ""}
                onChange={(e) => setFormData({ ...formData, "Sub-tag": e.target.value })}
                className="w-full px-3 py-2 border rounded"
              />
            </div>

            {/* Summary */}
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1">Summary</label>
              <textarea
                value={formData["summary"] || ""}
                onChange={(e) => setFormData({ ...formData, "summary": e.target.value })}
                className="w-full px-3 py-2 border rounded"
                rows={4}
                placeholder="Brief summary of the document"
              />
            </div>

            {/* File Name (read-only) */}
            <div className="col-span-2">
              <label className="block text-sm font-medium mb-1 text-gray-500">File</label>
              <input
                type="text"
                value={document.fileName}
                disabled
                className="w-full px-3 py-2 border rounded bg-gray-50 text-gray-500"
              />
            </div>
          </div>

          {/* Buttons */}
          <div className="flex gap-3 justify-end">
            <button
              type="button"
              onClick={onClose}
              className="px-4 py-2 border rounded hover:bg-gray-50"
              disabled={isLoading}
            >
              Cancel
            </button>
            <button
              type="submit"
              className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700 disabled:bg-gray-400"
              disabled={isLoading}
            >
              {isLoading ? "Saving..." : "Save Changes"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
```

---

## Next Steps

1. **Review plan** with user for feedback
2. **Proceed with Phase 1 implementation** if approved
3. **User testing** with actual metadata editing workflow
4. **Gather feedback** for Phase 2/3 decisions
5. **Document lessons learned** for future UI features
