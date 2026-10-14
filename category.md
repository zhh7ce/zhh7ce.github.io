---
layout: page
title: 分类
permalink: /category/
---

<div class="category">
  <h1>文章分类</h1>

  {% capture category_names %}{% for category in site.categories %}{{ category[0] }},{% endfor %}{% endcapture %}
  {% assign sorted_category_names = category_names | split: "," | sort_natural %}

  <ul id="categories">
  {% for name in sorted_category_names %}
    {% assign posts_in_category = site.categories[name] %}
    <li><a href="{{ site.baseurl }}/category/#{{ name }}">{{ name }}({{ posts_in_category | size }})</a></li>
  {% endfor %}
  </ul>

  <div class="post post-archive">
  {% for name in sorted_category_names %}
    {% assign posts_in_category = site.categories[name] %}
  <h3 id="{{ name }}">{{ name }}</h3>
  <ul class="arc-list">
      {% for post in posts_in_category %}
          <li><span class="date">{{ post.date | date: "%B %e, %Y" }}</span><a href="{{ post.url }}">{{ post.title }}</a></li>
      {% endfor %}
  </ul>
  {% endfor %}
  </div>
</div>
