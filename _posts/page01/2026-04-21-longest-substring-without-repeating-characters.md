---
layout: post
title:  "LeetCode 3. 无重复字符的最长子串"
date:   2026-04-21 10:00:00 +0800
categories: algorithm
---

## 题目描述
给定一个字符串 `s` ，请你找出其中不含有重复字符的 **最长子串** 的长度。

## 解题思路

### 方法：滑动窗口

1. **思路分析**：
   - 使用滑动窗口技术，通过维护一个左指针 `left` 和右指针 `right` 来表示当前窗口的范围。
   - 使用哈希集合 `set` 来存储窗口内的字符，确保窗口内无重复字符。
   - 右指针不断向右移动，将新字符加入集合，直到遇到重复字符。
   - 当遇到重复字符时，左指针向右移动，移除窗口最左侧的字符，直到窗口内不再有重复字符。
   - 在每一步中，记录窗口的最大长度。

2. **算法步骤**：
   - 初始化左指针 `left` 为 0，右指针 `right` 为 1，窗口长度 `length` 为 0，结果 `result` 为 0。
   - 当左指针小于字符串长度时，进入循环：
     - 如果是第一次循环（左指针为 0），将第一个字符加入集合，长度加 1。
     - 否则，移除左指针前一个位置的字符，长度减 1。
     - 左指针向右移动一位。
     - 右指针不断向右移动，将新字符加入集合，直到遇到重复字符或到达字符串末尾。
     - 更新结果为当前窗口长度和之前结果的较大值。
     - 如果右指针到达字符串末尾，跳出循环。
   - 返回结果。

## 代码实现

```java
package codetop.page01.a1;

import java.util.HashSet;
import java.util.Set;

/**
 * @author mlei@xjtu
 * @description 给定一个字符串 s ，请你找出其中不含有重复字符的 最长 子串 的长度。
 * @create 2026/4/11 17:46
 */
public class Solution {
    //滑动窗口
    public int lengthOfLongestSubstring(String s) {
        //小于2的长度不需要判断
        if(s.length()<2) return s.length();
        //去重
        Set<Character> set=new HashSet<>();
        int left=0,right=1,length=0,result=0;
        //每轮循环选一个起始点
        while (left<s.length()){
            //每轮移除一个左边的元素
            if(left==0){
                set.add(s.charAt(left));
                length++;
            }else {
                set.remove(s.charAt(left-1));
                length--;
            }
            left++;
            //从右边增加元素直到有重复为止，因此可以保证下一轮去除一个元素后依然是不重复子串，从right上轮的位置继续判断即可
            while (right<s.length()&&!set.contains(s.charAt(right))){
                set.add(s.charAt(right));
                right++;
                length++;
            }
            result= Math.max(result,length);
            if(right==s.length()) break;
        }
        return result;
    }
}
```

## 复杂度分析

- **时间复杂度**：O(n)，其中 n 是字符串的长度。左指针和右指针最多各移动 n 次，因此总时间复杂度为 O(n)。
- **空间复杂度**：O(min(m, n))，其中 m 是字符集的大小。哈希集合最多存储 min(m, n) 个字符。

## 示例

### 示例 1：
输入：`s = "abcabcbb"`
输出：`3`
解释：因为无重复字符的最长子串是 `"abc"`，所以其长度为 3。

### 示例 2：
输入：`s = "bbbbb"`
输出：`1`
解释：因为无重复字符的最长子串是 `"b"`，所以其长度为 1。

### 示例 3：
输入：`s = "pwwkew"`
输出：`3`
解释：因为无重复字符的最长子串是 `"wke"`，所以其长度为 3。

## 总结

滑动窗口是解决这类子串问题的有效方法，通过维护一个动态窗口，可以在 O(n) 的时间复杂度内找到最长无重复字符的子串。该方法的核心思想是利用哈希集合来快速判断字符是否重复，同时通过移动左右指针来调整窗口大小，确保窗口内始终是无重复字符的子串。