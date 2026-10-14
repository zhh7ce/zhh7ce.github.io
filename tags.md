---
layout: page
title: 标签
permalink: /tags/
---

<div id="tags">
  {% capture tag_names %}{% for tag in site.tags %}{{ tag[0] }},{% endfor %}{% endcapture %}
  {% assign sorted_tag_names = tag_names | split: "," | sort_natural %}

  <ul id="label_box">
  {% for name in sorted_tag_names %}
    {% assign posts_in_tag = site.tags[name] %}
    <li><a href="{{ site.baseurl }}/tags/#{{ name }}">{{ name }} <span>{{ posts_in_tag | size }}</span></a></li>
  {% endfor %}
  </ul>

  <div class="post post-archive">
  {% for name in sorted_tag_names %}
    {% assign posts_in_tag = site.tags[name] %}
  <h3 id="{{ name }}">{{ name }}</h3>
  <ul>
      {% for post in posts_in_tag %}
          <li><span class="date">{{ post.date | date: "%B %e, %Y" }}</span><a href="{{ post.url | prepend: site.baseurl }}">{{ post.title }}</a></li>
      {% endfor %}
  </ul>
  {% endfor %}
  </div>
</div>
