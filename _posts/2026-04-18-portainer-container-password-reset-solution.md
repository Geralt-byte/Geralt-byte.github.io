---
layout: post
title: "记录Portainer容器忘记密码解决方法"
date: 2026-04-18 10:00:00 +0800
categories: [Docker, DevOps]
tags: [Portainer, Docker, 密码重置, 容器管理]
---

## 问题描述

记录一次使用docker容器管理软件portainer忘记密码进行重置的过程。

![Portainer登录界面]({{ site.baseurl }}/assets/images/portainer/登录页面.png)

## 解决方案

通过容器挂载卷重置管理员账户密码：

---

### 步骤1：停止Portainer容器

```bash
docker ps
docker stop portainer
```

输出示例：
```
CONTAINER ID   IMAGE                    COMMAND                  CREATED        STATUS        PORTS                    NAMES
abc123def456  portainer/portainer-ce   "/portainer"             2 weeks ago    Up 2 hours    0.0.0.0:9000->9000/tcp   portainer
```

### 步骤2：执行密码重置命令

使用以下命令重置admin用户的密码：

```bash
docker exec -it portainer /portainer --admin-password
```

或者如果容器名称不同：

```bash
docker exec -it <container_name> /portainer --admin-password
```

### 步骤3：设置新密码

系统会提示你输入新密码：

```
Please specify the password for the admin user:
Enter password: 
Confirm password: 
```

![密码重置界面]({{ site.baseurl }}/assets/images/portainer/password-reset.png)

### 步骤4：验证重置结果

密码设置成功后，你就可以使用新密码登录Portainer管理界面了。

![登录成功界面]({{ site.baseurl }}/assets/images/portainer/login-success.png)

**注意事项：**
- 密码长度至少为12个字符
- 建议使用包含大小写字母、数字和特殊字符的强密码
- 重置密码后无需重启容器

---
