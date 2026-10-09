import Foundation

/// The project folder structure, copied from js/project-fields.js
/// PROJECT_FILE_CATEGORIES (the single source of truth on the web).
/// If folders change on the web, update this list to match.
struct FileSubfolder: Identifiable, Hashable {
    let key: String
    let label: String
    var children: [FileSubfolder] = []
    var id: String { key }
}

struct FileCategory: Identifiable, Hashable {
    let key: String
    let number: String
    let label: String
    let subfolders: [FileSubfolder]
    var id: String { key }
}

enum FileCategories {
    static let all: [FileCategory] = [
        FileCategory(key: "acquisition_due_diligence", number: "01", label: "Acquisition & Due Diligence", subfolders: [
            FileSubfolder(key: "purchase_sale", label: "Purchase & Sale"),
            FileSubfolder(key: "title", label: "Title"),
            FileSubfolder(key: "surveys", label: "Surveys"),
            FileSubfolder(key: "environmental", label: "Environmental"),
            FileSubfolder(key: "geotechnical", label: "Geotechnical"),
            FileSubfolder(key: "property_research", label: "Property Research"),
            FileSubfolder(key: "due_diligence_reports", label: "Due Diligence Reports"),
        ]),
        FileCategory(key: "development_entitlements", number: "02", label: "Development & Entitlements", subfolders: [
            FileSubfolder(key: "zoning", label: "Zoning"),
            FileSubfolder(key: "land_use", label: "Land Use"),
            FileSubfolder(key: "planning", label: "Planning"),
            FileSubfolder(key: "government_approvals", label: "Government Approvals"),
            FileSubfolder(key: "hoa_community_approvals", label: "HOA / Community Approvals"),
            FileSubfolder(key: "entitlements", label: "Entitlements"),
        ]),
        FileCategory(key: "design_engineering", number: "03", label: "Design & Engineering", subfolders: [
            FileSubfolder(key: "architecture", label: "Architecture"),
            FileSubfolder(key: "civil", label: "Civil"),
            FileSubfolder(key: "structural", label: "Structural"),
            FileSubfolder(key: "mep", label: "MEP"),
            FileSubfolder(key: "landscape", label: "Landscape"),
            FileSubfolder(key: "interior_design", label: "Interior Design"),
            FileSubfolder(key: "specifications", label: "Specifications"),
            FileSubfolder(key: "design_reviews", label: "Design Reviews"),
        ]),
        FileCategory(key: "permits_inspections", number: "04", label: "Permits & Inspections", subfolders: [
            FileSubfolder(key: "building_permits", label: "Building Permits"),
            FileSubfolder(key: "trade_permits", label: "Trade Permits"),
            FileSubfolder(key: "inspections", label: "Inspections"),
            FileSubfolder(key: "certificates", label: "Certificates"),
            FileSubfolder(key: "government_correspondence", label: "Government Correspondence"),
        ]),
        FileCategory(key: "contracts_procurement", number: "05", label: "Contracts & Procurement", subfolders: [
            FileSubfolder(key: "Project Forms Downloadable", label: "Project Form Downloadable"),
            FileSubfolder(key: "general_contractor", label: "General Contractor"),
            FileSubfolder(key: "subcontractors", label: "Subcontractors"),
            FileSubfolder(key: "vendors", label: "Vendors"),
            FileSubfolder(key: "purchase_orders", label: "Purchase Orders"),
            FileSubfolder(key: "contracts", label: "Contracts"),
            FileSubfolder(key: "back_charges", label: "Back Charges - BC", children: [
                FileSubfolder(key: "bc_without_signature", label: "BC Without Signature"),
                FileSubfolder(key: "bc_with_signature", label: "BC With Signature")
            ]),
            FileSubfolder(key: "vpo", label: "Variance Purchase Order - VPO", children: [
                FileSubfolder(key: "vpo_with_signature", label: "VPO With Signature"),
                FileSubfolder(key: "vpo_without_signature", label: "VPO Without Signature")
            ]),
            FileSubfolder(key: "insurance_bonds", label: "Insurance & Bonds"),
        ]),
        FileCategory(key: "construction", number: "06", label: "Construction", subfolders: [
            FileSubfolder(key: "daily_reports", label: "Daily Reports"),
            FileSubfolder(key: "site_photos", label: "Site Photos"),
            FileSubfolder(key: "field_reports", label: "Field Reports"),
            FileSubfolder(key: "rfis", label: "RFIs"),
            FileSubfolder(key: "submittals", label: "Submittals"),
            FileSubfolder(key: "inspections", label: "Inspections"),
            FileSubfolder(key: "safety", label: "Safety"),
            FileSubfolder(key: "quality_control", label: "Quality Control"),
            FileSubfolder(key: "progress_reports", label: "Progress Reports"),
            FileSubfolder(key: "incident_report", label: "Incident Report"),
        ]),
        FileCategory(key: "financial", number: "07", label: "Financial", subfolders: [
            FileSubfolder(key: "project_budget", label: "Project Budget"),
            FileSubfolder(key: "cost_tracking", label: "Cost Tracking"),
            FileSubfolder(key: "pay_applications", label: "Pay Applications"),
            FileSubfolder(key: "draws", label: "Draws"),
            FileSubfolder(key: "invoices", label: "Invoices"),
            FileSubfolder(key: "lien_waivers", label: "Lien Waivers"),
            FileSubfolder(key: "forecasts", label: "Forecasts"),
            FileSubfolder(key: "financial_reports", label: "Financial Reports"),
        ]),
        FileCategory(key: "marketing", number: "09", label: "Marketing", subfolders: [
            FileSubfolder(key: "branding", label: "Branding"),
            FileSubfolder(key: "logo_brand_assets", label: "Logo & Brand Assets"),
            FileSubfolder(key: "photography", label: "Photography"),
            FileSubfolder(key: "renderings", label: "Renderings"),
            FileSubfolder(key: "video", label: "Video"),
            FileSubfolder(key: "website", label: "Website"),
            FileSubfolder(key: "social_media", label: "Social Media"),
            FileSubfolder(key: "advertising", label: "Advertising"),
            FileSubfolder(key: "brochures_flyers", label: "Brochures & Flyers"),
            FileSubfolder(key: "signage", label: "Signage"),
            FileSubfolder(key: "press_public_relations", label: "Press & Public Relations"),
            FileSubfolder(key: "marketing_campaigns", label: "Marketing Campaigns"),
        ]),
        FileCategory(key: "communications", number: "10", label: "Communications", subfolders: [
            FileSubfolder(key: "owner", label: "Owner"),
            FileSubfolder(key: "architect", label: "Architect"),
            FileSubfolder(key: "contractor", label: "Contractor"),
            FileSubfolder(key: "subcontractors", label: "Subcontractors"),
            FileSubfolder(key: "vendors", label: "Vendors"),
            FileSubfolder(key: "government", label: "Government"),
            FileSubfolder(key: "public_community", label: "Public / Community"),
        ]),
        FileCategory(key: "closeout", number: "11", label: "Closeout", subfolders: [
            FileSubfolder(key: "punch_list", label: "Punch List"),
            FileSubfolder(key: "as_builts", label: "As-Builts"),
            FileSubfolder(key: "warranties", label: "Warranties"),
            FileSubfolder(key: "om_manuals", label: "O&M Manuals"),
            FileSubfolder(key: "final_inspections", label: "Final Inspections"),
            FileSubfolder(key: "certificates", label: "Certificates"),
            FileSubfolder(key: "certificate_of_occupancy", label: "Certificate of Occupancy"),
        ]),
    ]

    static func category(_ key: String) -> FileCategory? { all.first { $0.key == key } }
}
