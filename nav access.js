/* ===========================
   NAV ACCESS
=========================== */


function updateNavAccess(profile) {


    const shouldShowAdminNav =
        window.isSupabaseUserInGroup

        ? (
            window.isSupabaseUserInGroup(profile, "IT") ||
            window.isSupabaseUserInGroup(profile, "Super Admin")
          )

        : false;



    if (adminNavGroup) {

        adminNavGroup.style.display =
            shouldShowAdminNav
            ? "block"
            : "none";

    }



    const payrollToolsNavItem =
        document.getElementById("payrollToolsNavItem");


    // Payroll Tools is visible to the Office and Accounting
    // workgroups only (see permissions matrix).
    const shouldShowPayrollTools =
        window.isSupabaseUserInGroup

        ? (
            window.isSupabaseUserInGroup(profile, "Office") ||
            window.isSupabaseUserInGroup(profile, "Accounting") ||
            window.isSupabaseUserInGroup(profile, "Super Admin")
          )

        : false;



    if (payrollToolsNavItem) {

        payrollToolsNavItem.style.display =
            shouldShowPayrollTools
            ? "flex"
            : "none";

    }


}