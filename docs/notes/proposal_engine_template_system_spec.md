# Proposal Engine Template System Spec

## 1. Purpose

Build a proposal generation system that produces consistent, professional proposals using controlled HTML templates, structured proposal data, and deterministic PDF rendering.

The system must not rely on the AI agent to generate final document layout. Instead, the agent should extract and draft structured content, while the application owns the proposal structure, styling, headers, footers, branding, page layout, terms, and final PDF output.

The goal is to move from:

```text
Agent → Markdown → PDF
```

To:

```text
Source inputs → Agent structured extraction → Proposal data model → HTML template renderer → PDF
```

This will allow every proposal to maintain a consistent setout, cover sheet, embedded logo, headers, footers, styling, section order, fee layout, and terms.

---

## 2. Core Principles

### 2.1 The agent does not control layout

The agent may generate or suggest proposal content, but it must not generate the final proposal document structure.

The application controls:

- Cover page layout
- Logo placement
- Header and footer
- Page margins
- Fonts and styling
- Section order
- Fee table structure
- Terms and conditions
- Acceptance/signature section
- Page numbering
- PDF generation

The agent may generate:

- Project understanding
- Scope summary
- Inclusions
- Exclusions
- Assumptions
- Deliverables
- Timeline notes
- Risk notes
- Estimate commentary
- Suggested fee breakdown, subject to validation

---

## 3. High-Level Architecture

```text
Proposal Engine
├── Data Layer
│   ├── Proposal
│   ├── ProposalSection
│   ├── Estimate
│   ├── EstimateLineItem
│   ├── ProposalTemplate
│   ├── ProposalTheme
│   └── ProposalVersion
│
├── Agent Layer
│   ├── Scope extraction
│   ├── Missing information detection
│   ├── Draft proposal wording
│   ├── Estimate preparation
│   └── Proposal data validation support
│
├── Template Layer
│   ├── Base HTML template
│   ├── Cover page template
│   ├── Section partials
│   ├── Fee table partial
│   ├── Header/footer configuration
│   └── CSS theme files
│
└── Rendering Layer
    ├── HTML preview generation
    ├── PDF rendering
    ├── Version snapshotting
    └── File storage
```

---

## 4. Recommended Rendering Approach

Use server-rendered HTML templates with print CSS, then convert to PDF.

Recommended initial stack:

```text
Django Templates or Jinja2
        ↓
HTML + CSS
        ↓
WeasyPrint
        ↓
PDF
```

Alternative later option:

```text
React proposal preview
        ↓
Playwright / Chromium
        ↓
PDF
```

For the MVP, use Django templates or Jinja2 plus WeasyPrint because the proposal is a structured print document and needs reliable page layout, page counters, margins, and repeatable PDF output.

---

## 5. Proposed App Structure

Suggested Django app/module layout:

```text
backend/apps/proposals/
├── models.py
├── serializers.py
├── views.py
├── urls.py
├── services/
│   ├── proposal_builder.py
│   ├── proposal_renderer.py
│   ├── proposal_validator.py
│   ├── estimate_builder.py
│   ├── agent_payloads.py
│   └── versioning.py
├── templates/
│   └── proposals/
│       ├── base.html
│       ├── standard_proposal.html
│       ├── cover.html
│       ├── partials/
│       │   ├── project_summary.html
│       │   ├── project_understanding.html
│       │   ├── scope.html
│       │   ├── deliverables.html
│       │   ├── exclusions.html
│       │   ├── assumptions.html
│       │   ├── fee_table.html
│       │   ├── timeline.html
│       │   ├── terms.html
│       │   └── acceptance.html
│       └── themes/
│           ├── default.css
│           └── 3daro.css
├── static/
│   └── proposals/
│       ├── css/
│       └── images/
└── tests/
    ├── test_proposal_validation.py
    ├── test_proposal_rendering.py
    ├── test_estimate_builder.py
    └── test_versioning.py
```

---

## 6. Data Models

### 6.1 ProposalTemplate

Represents a reusable proposal structure.

```python
class ProposalTemplate(models.Model):
    name = models.CharField(max_length=255)
    key = models.SlugField(unique=True)
    description = models.TextField(blank=True)

    template_path = models.CharField(max_length=255)
    default_theme = models.ForeignKey(
        "ProposalTheme",
        null=True,
        blank=True,
        on_delete=models.SET_NULL,
        related_name="default_for_templates",
    )

    section_order = models.JSONField(default=list)
    required_sections = models.JSONField(default=list)
    optional_sections = models.JSONField(default=list)
    required_fields = models.JSONField(default=list)

    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

Example `section_order`:

```json
[
  "introduction",
  "project_understanding",
  "scope_of_services",
  "deliverables",
  "exclusions",
  "assumptions",
  "fee_proposal",
  "timeline",
  "terms",
  "acceptance"
]
```

---

### 6.2 ProposalTheme

Controls branding and styling configuration.

```python
class ProposalTheme(models.Model):
    name = models.CharField(max_length=255)
    key = models.SlugField(unique=True)

    logo = models.ImageField(upload_to="proposal_themes/logos/", null=True, blank=True)
    primary_colour = models.CharField(max_length=20, default="#3f51b5")
    secondary_colour = models.CharField(max_length=20, default="#1f2937")
    accent_colour = models.CharField(max_length=20, blank=True)

    font_family = models.CharField(max_length=255, default="Arial, sans-serif")
    css_path = models.CharField(max_length=255, blank=True)

    header_text = models.CharField(max_length=255, blank=True)
    footer_left_text = models.CharField(max_length=255, default="Commercial in Confidence")
    footer_right_text = models.CharField(max_length=255, blank=True)

    is_active = models.BooleanField(default=True)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

---

### 6.3 Proposal

Represents an individual proposal.

```python
class Proposal(models.Model):
    STATUS_DRAFT = "draft"
    STATUS_REVIEW = "review"
    STATUS_SENT = "sent"
    STATUS_ACCEPTED = "accepted"
    STATUS_REJECTED = "rejected"
    STATUS_ARCHIVED = "archived"

    STATUS_CHOICES = [
        (STATUS_DRAFT, "Draft"),
        (STATUS_REVIEW, "Review"),
        (STATUS_SENT, "Sent"),
        (STATUS_ACCEPTED, "Accepted"),
        (STATUS_REJECTED, "Rejected"),
        (STATUS_ARCHIVED, "Archived"),
    ]

    proposal_number = models.CharField(max_length=100, unique=True)
    title = models.CharField(max_length=255)

    client_name = models.CharField(max_length=255)
    client_contact_name = models.CharField(max_length=255, blank=True)
    client_email = models.EmailField(blank=True)

    project_name = models.CharField(max_length=255)
    project_location = models.CharField(max_length=255, blank=True)

    template = models.ForeignKey(ProposalTemplate, on_delete=models.PROTECT)
    theme = models.ForeignKey(ProposalTheme, null=True, blank=True, on_delete=models.SET_NULL)

    status = models.CharField(max_length=30, choices=STATUS_CHOICES, default=STATUS_DRAFT)
    proposal_date = models.DateField()
    valid_until = models.DateField(null=True, blank=True)

    currency = models.CharField(max_length=10, default="AUD")
    total_fee = models.DecimalField(max_digits=12, decimal_places=2, default=0)

    source_context = models.JSONField(default=dict, blank=True)
    structured_data = models.JSONField(default=dict, blank=True)

    latest_html = models.TextField(blank=True)
    latest_pdf = models.FileField(upload_to="proposals/pdfs/", null=True, blank=True)

    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

---

### 6.4 ProposalSection

Stores section-level content for the proposal.

```python
class ProposalSection(models.Model):
    CONTENT_MARKDOWN = "markdown"
    CONTENT_JSON = "json"
    CONTENT_HTML = "html"

    CONTENT_TYPE_CHOICES = [
        (CONTENT_MARKDOWN, "Markdown"),
        (CONTENT_JSON, "JSON"),
        (CONTENT_HTML, "HTML"),
    ]

    proposal = models.ForeignKey(Proposal, related_name="sections", on_delete=models.CASCADE)
    section_type = models.CharField(max_length=100)
    title = models.CharField(max_length=255)
    sort_order = models.PositiveIntegerField(default=0)

    content_type = models.CharField(max_length=20, choices=CONTENT_TYPE_CHOICES, default=CONTENT_MARKDOWN)
    content_markdown = models.TextField(blank=True)
    content_json = models.JSONField(default=dict, blank=True)
    rendered_html = models.TextField(blank=True)

    is_required = models.BooleanField(default=False)
    is_included = models.BooleanField(default=True)
    is_locked = models.BooleanField(default=False)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

Locked sections should not be editable by the agent. Examples include terms, legal clauses, payment terms, and acceptance wording.

---

### 6.5 Estimate

Stores internal estimate information.

```python
class Estimate(models.Model):
    METHOD_MANUAL = "manual"
    METHOD_STAGE_BASED = "stage_based"
    METHOD_TASK_BASED = "task_based"
    METHOD_HISTORICAL = "historical"

    METHOD_CHOICES = [
        (METHOD_MANUAL, "Manual"),
        (METHOD_STAGE_BASED, "Stage Based"),
        (METHOD_TASK_BASED, "Task Based"),
        (METHOD_HISTORICAL, "Historical"),
    ]

    proposal = models.OneToOneField(Proposal, related_name="estimate", on_delete=models.CASCADE)
    method = models.CharField(max_length=50, choices=METHOD_CHOICES, default=METHOD_STAGE_BASED)

    internal_notes = models.TextField(blank=True)
    client_notes = models.TextField(blank=True)

    subtotal = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    discount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    tax = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    total = models.DecimalField(max_digits=12, decimal_places=2, default=0)

    confidence_level = models.CharField(max_length=50, blank=True)
    risk_rating = models.CharField(max_length=50, blank=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

---

### 6.6 EstimateLineItem

Stores fee breakdown items.

```python
class EstimateLineItem(models.Model):
    estimate = models.ForeignKey(Estimate, related_name="line_items", on_delete=models.CASCADE)

    stage = models.CharField(max_length=255)
    task_category = models.CharField(max_length=255, blank=True)
    description = models.TextField(blank=True)

    quantity = models.DecimalField(max_digits=10, decimal_places=2, default=1)
    unit = models.CharField(max_length=50, default="item")
    rate = models.DecimalField(max_digits=12, decimal_places=2, default=0)

    base_hours = models.DecimalField(max_digits=10, decimal_places=2, default=0)
    complexity_multiplier = models.DecimalField(max_digits=6, decimal_places=2, default=1)
    risk_multiplier = models.DecimalField(max_digits=6, decimal_places=2, default=1)

    internal_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)
    client_amount = models.DecimalField(max_digits=12, decimal_places=2, default=0)

    sort_order = models.PositiveIntegerField(default=0)
    is_optional = models.BooleanField(default=False)
    is_client_visible = models.BooleanField(default=True)

    created_at = models.DateTimeField(auto_now_add=True)
    updated_at = models.DateTimeField(auto_now=True)
```

---

### 6.7 ProposalVersion

Stores immutable snapshots of issued/generated proposal versions.

```python
class ProposalVersion(models.Model):
    proposal = models.ForeignKey(Proposal, related_name="versions", on_delete=models.CASCADE)
    version_number = models.PositiveIntegerField()

    data_snapshot = models.JSONField(default=dict)
    html_snapshot = models.TextField(blank=True)
    pdf_file = models.FileField(upload_to="proposals/versions/", null=True, blank=True)

    change_notes = models.TextField(blank=True)
    created_by = models.ForeignKey(settings.AUTH_USER_MODEL, null=True, blank=True, on_delete=models.SET_NULL)
    created_at = models.DateTimeField(auto_now_add=True)

    class Meta:
        unique_together = ("proposal", "version_number")
```

---

## 7. Structured Proposal Data Shape

The agent and backend services should work with a predictable structured payload.

Example target payload:

```json
{
  "project": {
    "name": "Goldies Farm Shed Upgrade",
    "location": "Queensland",
    "client_name": "ABC Constructions",
    "client_contact_name": "Matt",
    "proposal_number": "PROP-2026-014",
    "date": "2026-05-24",
    "valid_until": "2026-06-24"
  },
  "scope": {
    "summary": "Preparation of preliminary drafting and design documentation for the proposed shed works.",
    "included": [
      "Review supplied architectural and structural information",
      "Prepare preliminary shed layout drawings",
      "Prepare site layout and coordination drawings",
      "Prepare elevations, sections and typical details"
    ],
    "excluded": [
      "Engineering certification",
      "Council application fees",
      "Detailed hydraulic, electrical or mechanical design",
      "Site inspections unless specifically requested"
    ],
    "assumptions": [
      "Client will provide existing site information in DWG or PDF format",
      "Structural engineering information will be provided by others",
      "One round of client review is included per stage"
    ]
  },
  "deliverables": [
    "PDF drawing issue",
    "DWG files where required",
    "Coordination markups and review drawings"
  ],
  "fees": {
    "currency": "AUD",
    "total": 5000,
    "breakdown": [
      {
        "stage": "Preliminary Design",
        "fee": 1000,
        "description": "Initial review, setup and preliminary layout documentation"
      },
      {
        "stage": "Design Development",
        "fee": 3000,
        "description": "Developed drawings, coordination and documentation refinement"
      },
      {
        "stage": "Construction Design",
        "fee": 1000,
        "description": "Final construction issue documentation"
      }
    ]
  },
  "timeline": {
    "start_date": "2026-04-10",
    "notes": "Program subject to timely receipt of client and consultant information."
  }
}
```

---

## 8. Template System

### 8.1 Base template

`base.html` should define the global HTML structure and load theme CSS.

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>{{ proposal.title }}</title>
  <link rel="stylesheet" href="{{ theme_css_path }}">
</head>
<body>
  {% block content %}{% endblock %}
</body>
</html>
```

---

### 8.2 Standard proposal template

`standard_proposal.html` should compose the proposal from fixed partials.

```html
{% extends "proposals/base.html" %}

{% block content %}
  {% include "proposals/cover.html" %}

  <main class="proposal-body">
    {% include "proposals/partials/project_summary.html" %}
    {% include "proposals/partials/project_understanding.html" %}
    {% include "proposals/partials/scope.html" %}
    {% include "proposals/partials/deliverables.html" %}
    {% include "proposals/partials/exclusions.html" %}
    {% include "proposals/partials/assumptions.html" %}
    {% include "proposals/partials/fee_table.html" %}
    {% include "proposals/partials/timeline.html" %}
    {% include "proposals/partials/terms.html" %}
    {% include "proposals/partials/acceptance.html" %}
  </main>
{% endblock %}
```

---

### 8.3 Cover page

```html
<section class="cover-page">
  <div class="cover-logo-wrap">
    {% if theme.logo_url %}
      <img src="{{ theme.logo_url }}" class="cover-logo" alt="Company logo">
    {% endif %}
  </div>

  <div class="cover-title-block">
    <p class="document-label">Fee Proposal</p>
    <h1>{{ proposal.project_name }}</h1>
    {% if proposal.project_location %}
      <p class="project-location">{{ proposal.project_location }}</p>
    {% endif %}
  </div>

  <div class="cover-meta">
    <p><strong>Prepared for:</strong> {{ proposal.client_name }}</p>
    <p><strong>Proposal No:</strong> {{ proposal.proposal_number }}</p>
    <p><strong>Date:</strong> {{ proposal.proposal_date }}</p>
  </div>
</section>
```

---

### 8.4 Print CSS

Example `3daro.css`:

```css
@page {
  size: A4;
  margin: 25mm 18mm 22mm 18mm;

  @top-left {
    content: "3Daro";
    font-size: 9pt;
    color: #555;
  }

  @top-right {
    content: "Fee Proposal";
    font-size: 9pt;
    color: #555;
  }

  @bottom-left {
    content: "Commercial in Confidence";
    font-size: 8pt;
    color: #777;
  }

  @bottom-right {
    content: "Page " counter(page) " of " counter(pages);
    font-size: 8pt;
    color: #777;
  }
}

@page:first {
  margin: 0;

  @top-left { content: none; }
  @top-right { content: none; }
  @bottom-left { content: none; }
  @bottom-right { content: none; }
}

body {
  font-family: Arial, sans-serif;
  font-size: 10.5pt;
  line-height: 1.45;
  color: #1f2937;
}

.cover-page {
  page-break-after: always;
  width: 210mm;
  height: 297mm;
  padding: 35mm 25mm;
  box-sizing: border-box;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.cover-logo {
  max-width: 55mm;
  height: auto;
}

.document-label {
  text-transform: uppercase;
  letter-spacing: 0.12em;
  color: #3f51b5;
  font-size: 11pt;
  font-weight: bold;
}

.cover-title-block h1 {
  font-size: 28pt;
  line-height: 1.15;
  margin: 0;
  color: #111827;
}

.proposal-body h2 {
  color: #3f51b5;
  font-size: 15pt;
  margin-top: 18pt;
  margin-bottom: 8pt;
  page-break-after: avoid;
}

.proposal-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 10pt 0;
}

.proposal-body th,
.proposal-body td {
  border-bottom: 1px solid #ddd;
  padding: 7pt 5pt;
  vertical-align: top;
}

.proposal-body th {
  text-align: left;
  color: #111827;
  font-weight: bold;
}

.text-right {
  text-align: right;
}

.total-row td {
  font-weight: bold;
  border-top: 2px solid #111827;
}
```

---

## 9. Renderer Service

Create a dedicated service responsible for rendering HTML and PDF.

Suggested file:

```text
services/proposal_renderer.py
```

Responsibilities:

- Build render context
- Convert markdown sections to safe HTML
- Load template
- Render HTML
- Render PDF
- Save latest HTML and PDF to proposal
- Optionally create a version snapshot

Example service shape:

```python
class ProposalRenderer:
    def render_html(self, proposal: Proposal) -> str:
        context = self.build_context(proposal)
        template_path = proposal.template.template_path
        return render_to_string(template_path, context)

    def render_pdf(self, proposal: Proposal, save: bool = True):
        html = self.render_html(proposal)
        pdf_bytes = self.html_to_pdf(html, proposal)

        if save:
            self.save_outputs(proposal, html, pdf_bytes)

        return pdf_bytes

    def build_context(self, proposal: Proposal) -> dict:
        return {
            "proposal": proposal,
            "sections": self.get_rendered_sections(proposal),
            "estimate": getattr(proposal, "estimate", None),
            "theme": self.get_theme_context(proposal),
            "structured_data": proposal.structured_data,
        }
```

---

## 10. Proposal Validator

Create a validation service before rendering.

Suggested file:

```text
services/proposal_validator.py
```

Validation should check:

- Proposal has a template
- Proposal has a proposal number
- Proposal has a client name
- Proposal has a project name
- Proposal has a proposal date
- Required sections exist
- Required sections are not empty
- Estimate exists if fee section is required
- Fee total matches visible line items
- Terms section exists and is locked
- Required branding assets are available if template requires them

Example:

```python
class ProposalValidator:
    def validate_for_render(self, proposal: Proposal) -> list[str]:
        errors = []

        if not proposal.template:
            errors.append("Proposal template is required.")

        if not proposal.client_name:
            errors.append("Client name is required.")

        if not proposal.project_name:
            errors.append("Project name is required.")

        if not proposal.proposal_date:
            errors.append("Proposal date is required.")

        required_sections = proposal.template.required_sections or []
        existing_sections = set(
            proposal.sections.filter(is_included=True).values_list("section_type", flat=True)
        )

        for section_type in required_sections:
            if section_type not in existing_sections:
                errors.append(f"Required section missing: {section_type}")

        if "fee_proposal" in required_sections and not hasattr(proposal, "estimate"):
            errors.append("Estimate is required for fee proposal section.")

        return errors
```

---

## 11. Agent Responsibilities

The agent should be used as a content and extraction assistant, not as the final document renderer.

### 11.1 Agent input

The agent may receive:

- Client emails
- Uploaded scope documents
- Meeting notes
- Previous similar proposals
- Project metadata
- User notes
- Estimate inputs
- Known company defaults

### 11.2 Agent output

The agent should return structured JSON matching the expected proposal schema.

Example agent output:

```json
{
  "project": {
    "name": "",
    "location": "",
    "client_name": ""
  },
  "sections": [
    {
      "section_type": "project_understanding",
      "title": "Project Understanding",
      "content_markdown": ""
    },
    {
      "section_type": "scope_of_services",
      "title": "Scope of Services",
      "content_json": {
        "included": [],
        "excluded": [],
        "assumptions": []
      }
    }
  ],
  "estimate": {
    "method": "stage_based",
    "line_items": []
  },
  "missing_information": [],
  "risks": [],
  "confidence": "medium"
}
```

### 11.3 Agent must not overwrite locked sections

The agent must not modify:

- Terms and conditions
- Acceptance wording
- Legal clauses
- Standard payment terms
- Company disclaimers
- Header/footer content
- Branding/theme data

Unless the user explicitly unlocks or edits those sections.

---

## 12. Template and Agent Boundary Rules

Use these rules in the agent prompt/system instructions:

```text
You are assisting with proposal preparation.

You must output structured proposal data only.
You must not design the document layout.
You must not create final HTML, CSS, page headers, footers, or cover sheet layout.
You may draft editable proposal content such as project understanding, scope, inclusions, exclusions, assumptions, deliverables, and timeline notes.
You must not modify locked sections such as terms, payment clauses, legal disclaimers, or acceptance wording.
If information is missing, return it in missing_information rather than inventing it.
If an estimate is uncertain, include assumptions and confidence level.
```

---

## 13. Proposal Generation Workflow

### 13.1 Draft creation flow

```text
1. User creates proposal from project, email, uploaded scope or manual entry
2. User selects proposal template
3. System creates Proposal record
4. System creates default required ProposalSection records from template
5. Agent extracts structured data from inputs
6. Agent fills editable sections and estimate draft
7. System validates required fields
8. User reviews and edits proposal content
9. System renders HTML preview
10. User approves
11. System renders PDF and creates ProposalVersion
```

---

### 13.2 Regeneration flow

```text
1. User updates scope/fee/input data
2. Agent optionally updates editable content only
3. System re-validates proposal
4. System re-renders HTML preview
5. User approves new issue
6. System creates new ProposalVersion
```

---

## 14. API Endpoints

Suggested REST endpoints:

```text
GET    /api/proposals/
POST   /api/proposals/
GET    /api/proposals/{id}/
PATCH  /api/proposals/{id}/
DELETE /api/proposals/{id}/

POST   /api/proposals/{id}/run-agent-draft/
POST   /api/proposals/{id}/validate/
POST   /api/proposals/{id}/render-preview/
POST   /api/proposals/{id}/render-pdf/
POST   /api/proposals/{id}/issue-version/

GET    /api/proposals/{id}/sections/
POST   /api/proposals/{id}/sections/
PATCH  /api/proposal-sections/{id}/
DELETE /api/proposal-sections/{id}/

GET    /api/proposal-templates/
GET    /api/proposal-themes/

GET    /api/proposals/{id}/estimate/
PATCH  /api/proposals/{id}/estimate/
POST   /api/proposals/{id}/estimate/line-items/
PATCH  /api/estimate-line-items/{id}/
DELETE /api/estimate-line-items/{id}/
```

---

## 15. Frontend Requirements

The frontend should support:

### 15.1 Proposal detail page

Sections:

- Proposal header
- Status
- Client/project metadata
- Template/theme selection
- Proposal sections editor
- Estimate editor
- Validation panel
- HTML preview
- PDF download/generate button
- Version history

### 15.2 Section editor

Each section should display:

- Section title
- Included/excluded toggle
- Locked status
- Markdown editor or structured list editor depending on section type
- Agent regenerate button for editable sections

### 15.3 Estimate editor

Should support:

- Stage-based fee lines
- Task-based fee lines later
- Internal estimate values
- Client-visible fee values
- Optional hidden internal notes
- Recalculate total

### 15.4 Preview

The preview should show server-rendered HTML, ideally in an iframe or preview panel.

The preview should not be hand-rebuilt separately in React unless necessary. The server-rendered HTML preview should represent the PDF as closely as possible.

---

## 16. MVP Scope

### Include in MVP

- ProposalTemplate model
- ProposalTheme model
- Proposal model
- ProposalSection model
- Estimate model
- EstimateLineItem model
- ProposalVersion model
- One standard proposal template
- One 3Daro/default theme
- Cover page with logo
- Header/footer with page numbering
- Fixed section order
- Markdown body content inside controlled sections
- Fee table rendering from estimate line items
- HTML preview endpoint
- PDF render endpoint
- Proposal validation endpoint
- Agent structured draft endpoint
- Version snapshot when issuing proposal

### Exclude from MVP

- Complex client-specific themes
- Live collaborative editing
- Full DOCX export
- E-signature integration
- Accounting integration
- Proposal acceptance portal
- Historical ML-based fee prediction
- Advanced visual template designer

---

## 17. Initial Standard Proposal Sections

The first template should include:

1. Cover Page
2. Introduction
3. Project Understanding
4. Scope of Services
5. Deliverables
6. Exclusions
7. Assumptions
8. Fee Proposal
9. Timeline / Program
10. Terms and Conditions
11. Acceptance

---

## 18. Section Types

Recommended section type keys:

```text
introduction
project_understanding
scope_of_services
deliverables
exclusions
assumptions
fee_proposal
timeline
terms
acceptance
```

---

## 19. Locked Standard Sections

The following sections should generally be locked by default:

```text
terms
acceptance
payment_terms
legal_disclaimer
```

The agent must not overwrite these sections.

---

## 20. Estimate Display Rules

The internal estimate may include:

- Hours
- Rates
- Multipliers
- Risk allowances
- Complexity scores
- Internal notes
- Margin assumptions

The client-facing proposal should initially show only:

- Stage/task name
- Description
- Fee
- Total

Example client-facing table:

```text
Stage                    Description                                  Fee
Preliminary Design       Initial review and preliminary layouts        $1,000
Design Development       Developed documentation and coordination      $3,000
Construction Design      Final construction issue documentation        $1,000
Total                                                                 $5,000
```

---

## 21. Security and Safety

The renderer must sanitise user/agent-generated markdown before converting to HTML.

Important rules:

- Do not allow arbitrary script tags
- Do not allow unsafe inline event handlers
- Do not allow the agent to inject CSS into the document
- Do not allow the agent to modify template paths
- Do not allow the agent to modify file paths for assets
- Do not allow the agent to override locked terms
- Validate all structured data before saving

---

## 22. Testing Requirements

Add tests for:

### 22.1 Proposal validation

- Missing client name fails validation
- Missing project name fails validation
- Missing required section fails validation
- Missing estimate fails when fee section is required
- Locked section cannot be agent-overwritten

### 22.2 Rendering

- Proposal renders HTML successfully
- Proposal renders PDF successfully
- Cover page includes logo
- Fee table includes correct line items
- Total fee is correct
- Header/footer appears on non-cover pages

### 22.3 Versioning

- Issuing proposal creates version snapshot
- Version number increments
- Old version snapshot remains unchanged after proposal edits

### 22.4 Agent integration

- Agent output is parsed into structured data
- Invalid agent output is rejected
- Missing information is surfaced to user
- Agent cannot write locked sections

---

## 23. Implementation Phases

### Phase 1 — Backend models and seed data

- Create proposal models
- Create migrations
- Seed default ProposalTemplate
- Seed default ProposalTheme
- Seed standard sections

### Phase 2 — Rendering system

- Add base HTML template
- Add standard proposal template
- Add cover page
- Add partial templates
- Add CSS theme
- Add HTML renderer
- Add PDF renderer

### Phase 3 — Validation and versioning

- Add ProposalValidator
- Add issue-version service
- Add render-preview endpoint
- Add render-pdf endpoint
- Add version history

### Phase 4 — Agent structured drafting

- Define agent input/output schema
- Create run-agent-draft endpoint
- Parse agent output into Proposal/ProposalSection/Estimate models
- Enforce locked section rules
- Surface missing information and risks

### Phase 5 — Frontend editor and preview

- Create proposal list/detail pages
- Add section editor
- Add estimate editor
- Add validation panel
- Add HTML preview iframe
- Add PDF generation/download action
- Add version history panel

---

## 24. Acceptance Criteria

The implementation is considered successful when:

- A user can create a proposal from a standard template
- The proposal has a branded cover page with logo
- The proposal renders with consistent headers and footers
- Sections render in a fixed order
- Editable sections can be updated without changing layout
- Estimate line items render into a client-facing fee table
- PDF output is generated from the HTML template
- Proposal validation catches missing required data
- The agent can populate structured proposal content
- The agent cannot overwrite locked terms or layout
- Issuing a proposal creates an immutable version snapshot

---

## 25. Future Enhancements

Potential future features:

- Multiple proposal templates by work type
- Client-specific branding themes
- Proposal acceptance portal
- E-signature support
- Xero/QuickBooks quote/invoice creation
- Historical fee analysis
- Proposal-to-project conversion
- Scope comparison between proposal versions
- AI-assisted variation proposal generation
- Proposal analytics and win/loss tracking
- DOCX export
- Template designer UI

---

## 26. Key Implementation Reminder

The proposal system should be deterministic.

The agent helps prepare content.

The application owns the structure.

The renderer owns the document.

The final PDF should always be generated from validated structured data and controlled HTML templates, never from uncontrolled freeform agent output.

