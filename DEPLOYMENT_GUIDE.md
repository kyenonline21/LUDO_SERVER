# Hướng dẫn Deploy Server lên Ubuntu

## 1. Kiểm tra Server đang chạy
```bash
# Kiểm tra process
ps aux | grep node

# Kiểm tra port 3000
netstat -tulpn | grep 3000
# hoặc
ss -tulpn | grep 3000
```

## 2. Cấu hình Firewall (ufw)
```bash
# Kiểm tra status firewall
sudo ufw status

# Cho phép port 3000
sudo ufw allow 3000/tcp

# Reload firewall
sudo ufw reload

# Verify
sudo ufw status numbered
```

## 3. Kiểm tra Server bind đúng IP
Server.js cần bind 0.0.0.0 để accept connections từ bên ngoài:

```javascript
server.listen(PORT, '0.0.0.0', () => {
    console.log(`Server running on 0.0.0.0:${PORT}`);
});
```

## 4. Test kết nối từ bên ngoài
```bash
# Từ máy local, test HTTP endpoint
curl http://103.231.190.56:3000

# Test với telnet
telnet 103.231.190.56 3000

# Test với nc (netcat)
nc -zv 103.231.190.56 3000
```

## 5. Chạy Server với PM2 (Production)
```bash
# Install PM2
npm install -g pm2

# Start server
pm2 start server.js --name ludo-server

# Auto restart on reboot
pm2 startup
pm2 save

# Xem logs
pm2 logs ludo-server

# Restart
pm2 restart ludo-server

# Stop
pm2 stop ludo-server
```

## 6. Kiểm tra Security Group (nếu dùng Cloud)
- AWS EC2: Security Group phải mở inbound port 3000
- Azure: Network Security Group phải allow port 3000
- Google Cloud: Firewall rules phải allow port 3000

## 7. Logs để debug
```bash
# Xem system logs
sudo journalctl -u nodejs -f

# Xem PM2 logs
pm2 logs

# Xem server logs
tail -f /path/to/server.log
```

## 8. Client Configuration
Trong Unity, đổi URL:
```csharp
SERVER_URL = "http://103.231.190.56:3000";  // HTTP không phải HTTPS
```

## 9. Test checklist
- [ ] Server đang chạy (ps aux | grep node)
- [ ] Port 3000 đang listen (netstat -tulpn | grep 3000)
- [ ] Firewall đã mở port 3000 (ufw status)
- [ ] Server bind đúng 0.0.0.0
- [ ] Có thể curl từ bên ngoài
- [ ] Client dùng http:// không phải https://
- [ ] Security Group/Firewall cloud đã mở port

## 10. Common Issues

### Issue: Connection refused
```bash
# Check server is running
sudo systemctl status nodejs
pm2 status

# Restart server
pm2 restart ludo-server
```

### Issue: Timeout
```bash
# Check firewall
sudo ufw status
sudo iptables -L -n

# Check if port is open
sudo netstat -tulpn | grep 3000
```

### Issue: WebSocket upgrade failed
- Kiểm tra CORS settings trong server.js
- Đảm bảo client dùng đúng transports: ['websocket', 'polling']
