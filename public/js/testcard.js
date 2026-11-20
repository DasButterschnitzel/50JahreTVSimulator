// Testbild und Störungstafel, gezeichnet auf einer 768x576-Leinwand (PAL).

const W = 768;
const H = 576;

const BARS = ['#bfbfbf', '#bfbf00', '#00bfbf', '#00bf00', '#bf00bf', '#bf0000', '#0000bf', '#000000'];

function fitText(ctx, text, maxWidth, size, weight = 'bold') {
  let px = size;
  do {
    ctx.font = `${weight} ${px}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    px -= 1;
  } while (px > 8 && ctx.measureText(text).width > maxWidth);
}

export function drawTestcard(canvas, { title = '', subtitle = '' } = {}) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  const cx = W / 2;
  const cy = H / 2;

  // Grauer Grund mit Gitter
  ctx.fillStyle = '#6a6a6a';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#e6e6e6';
  ctx.lineWidth = 2;
  const cell = 48;
  ctx.beginPath();
  for (let x = cx % cell; x <= W; x += cell) {
    ctx.moveTo(x, 0);
    ctx.lineTo(x, H);
  }
  for (let y = cy % cell; y <= H; y += cell) {
    ctx.moveTo(0, y);
    ctx.lineTo(W, y);
  }
  ctx.stroke();

  // Randmarken
  ctx.fillStyle = '#ffffff';
  for (const [x, y] of [
    [0, 0],
    [W - 48, 0],
    [0, H - 48],
    [W - 48, H - 48],
  ]) {
    ctx.fillRect(x, y, 48, 48);
    ctx.fillStyle = '#000000';
    ctx.fillRect(x + 12, y + 12, 24, 24);
    ctx.fillStyle = '#ffffff';
  }

  // Kreis mit Messfeldern
  const radius = 252;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.clip();
  const left = cx - radius;
  const width = radius * 2;
  const rows = [
    { h: 72, draw: 'title' },
    { h: 96, draw: 'bars' },
    { h: 60, draw: 'grey' },
    { h: 48, draw: 'center' },
    { h: 60, draw: 'bursts' },
    { h: 96, draw: 'ramp' },
    { h: 72, draw: 'subtitle' },
  ];
  let y = cy - radius;
  for (const row of rows) {
    switch (row.draw) {
      case 'title':
      case 'subtitle': {
        ctx.fillStyle = '#000000';
        ctx.fillRect(left, y, width, row.h);
        const text = row.draw === 'title' ? title : subtitle;
        if (text) {
          ctx.fillStyle = '#ffffff';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          const inset = row.draw === 'title' ? row.h * 0.62 : row.h * 0.38;
          fitText(ctx, text, width * 0.55, 34);
          ctx.fillText(text, cx, y + inset);
        }
        break;
      }
      case 'bars': {
        const bw = width / BARS.length;
        BARS.forEach((color, i) => {
          ctx.fillStyle = color;
          ctx.fillRect(left + i * bw, y, bw + 1, row.h);
        });
        break;
      }
      case 'grey': {
        const steps = 6;
        const sw = width / steps;
        for (let i = 0; i < steps; i++) {
          const v = Math.round((i / (steps - 1)) * 255);
          ctx.fillStyle = `rgb(${v},${v},${v})`;
          ctx.fillRect(left + i * sw, y, sw + 1, row.h);
        }
        break;
      }
      case 'center': {
        ctx.fillStyle = '#000000';
        ctx.fillRect(left, y, width, row.h);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(left, y + row.h / 2 - 1, width, 2);
        for (let x = cx - 240; x <= cx + 240; x += 24) ctx.fillRect(x - 1, y + 8, 2, row.h - 16);
        break;
      }
      case 'bursts': {
        ctx.fillStyle = '#7a7a7a';
        ctx.fillRect(left, y, width, row.h);
        const groups = [8, 6, 4, 3, 2];
        const gw = (width * 0.8) / groups.length;
        groups.forEach((period, i) => {
          const gx = left + width * 0.1 + i * gw;
          for (let x = 0; x < gw - 10; x += period) {
            ctx.fillStyle = Math.floor(x / period) % 2 ? '#000000' : '#ffffff';
            ctx.fillRect(gx + x, y, period, row.h);
          }
        });
        break;
      }
      case 'ramp': {
        const half = row.h / 2;
        const grad = ctx.createLinearGradient(left, 0, left + width, 0);
        grad.addColorStop(0, '#000000');
        grad.addColorStop(1, '#ffffff');
        ctx.fillStyle = grad;
        ctx.fillRect(left, y, width, half);
        const colors = ['#bf0000', '#00bf00', '#0000bf', '#bfbf00'];
        const cw = width / colors.length;
        colors.forEach((color, i) => {
          ctx.fillStyle = color;
          ctx.fillRect(left + i * cw, y + half, cw + 1, half);
        });
        break;
      }
    }
    y += row.h;
  }
  ctx.restore();

  ctx.strokeStyle = '#ffffff';
  ctx.lineWidth = 3;
  ctx.beginPath();
  ctx.arc(cx, cy, radius, 0, Math.PI * 2);
  ctx.stroke();
}

export function drawFaultCard(canvas, { title = 'BILDSTÖRUNG', subtitle = 'Wir bitten um etwas Geduld' } = {}) {
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#20324a';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = '#d8d2bd';
  ctx.lineWidth = 4;
  ctx.strokeRect(70, 150, W - 140, H - 300);
  ctx.fillStyle = '#efe8d2';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  fitText(ctx, title, W - 220, 62);
  ctx.fillText(title, W / 2, H / 2 - 34);
  fitText(ctx, subtitle, W - 220, 30, 'normal');
  ctx.fillText(subtitle, W / 2, H / 2 + 42);
}
