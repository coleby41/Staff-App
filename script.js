const menuBtn = document.getElementById('menuBtn');
const sidebar = document.getElementById('sidebar');
const mainContent = document.querySelector('.main-content');

if (menuBtn && sidebar && mainContent) {
    menuBtn.addEventListener('click', () => {
        sidebar.classList.toggle('hidden');
        mainContent.classList.toggle('expanded');
    });
}

function handleResize() {
    if (!sidebar || !mainContent) return;

    if (window.innerWidth <= 768) {
        sidebar.classList.add('hidden');
        mainContent.classList.add('expanded');
    } else {
        sidebar.classList.remove('hidden');
        mainContent.classList.remove('expanded');
    }
}

window.addEventListener('resize', handleResize);
handleResize();

if (typeof IntersectionObserver !== 'undefined') {
    const observerOptions = {
        threshold: 0.1,
        rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
        entries.forEach(entry => {
            if (entry.isIntersecting) {
                entry.target.style.opacity = '1';
                entry.target.style.transform = 'translateY(0)';
            }
        });
    }, observerOptions);

    document.querySelectorAll('.card').forEach(card => {
        card.style.opacity = '0';
        card.style.transform = 'translateY(20px)';
        card.style.transition = 'opacity 0.5s ease, transform 0.5s ease';
        observer.observe(card);
    });
}

function formatDate(dateString) {
    const options = { month: 'short', day: 'numeric', year: 'numeric' };
    return new Date(dateString).toLocaleDateString('en-US', options);
}

function toggleSubnav(event, el) {
    event.preventDefault();
    el.classList.toggle('expanded');
    el.nextElementSibling.classList.toggle('expanded');
}

