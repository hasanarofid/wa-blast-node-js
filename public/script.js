// Navbar scroll effect
window.addEventListener('scroll', () => {
    const navbar = document.querySelector('.navbar');
    if (window.scrollY > 50) {
        navbar.classList.add('scrolled');
    } else {
        navbar.classList.remove('scrolled');
    }
});

// Floating Cuan interactions
const floatingCuan = document.getElementById('toggleChat');

floatingCuan.addEventListener('mouseover', () => {
    const emojis = ['💰', '💵', '💸', '✨'];
    const randomEmoji = emojis[Math.floor(Math.random() * emojis.length)];
    
    const pop = document.createElement('div');
    pop.innerText = randomEmoji;
    pop.style.position = 'absolute';
    pop.style.fontSize = '24px';
    pop.style.left = '50%';
    pop.style.top = '0';
    pop.style.transform = 'translate(-50%, -50%)';
    pop.style.pointerEvents = 'none';
    pop.style.transition = 'all 0.6s ease-out';
    pop.style.opacity = '1';
    
    floatingCuan.appendChild(pop);
    
    setTimeout(() => {
        pop.style.transform = `translate(-50%, -${80 + Math.random() * 40}px) rotate(${Math.random() * 60 - 30}deg)`;
        pop.style.opacity = '0';
    }, 50);
    
    setTimeout(() => {
        pop.remove();
    }, 600);
});
