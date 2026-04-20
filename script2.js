async function fetchPosts() {
  try {
    const response = await fetch('https://jsonplaceholder.typicode.com/posts');
    const posts = await response.json();

    // Take only the first 10 entries
    const first10 = posts.slice(0, 10);

    const tableBody = document.querySelector('#postTable tbody');
    tableBody.innerHTML = '';

    first10.forEach((post, index) => {
      const row = document.createElement('tr');
      row.innerHTML = `
        <td>${index + 1}</td>
        <td>${post.id}</td>
        <td>${post.userId}</td>
        <td>${post.title}</td>
        <td>${post.body}</td>
      `;
      tableBody.appendChild(row);
    });
  } catch (error) {
    console.error('Error fetching posts:', error);
  }
}

fetchPosts();